import prisma from '../../lib/prisma';
import { AlertType, AlertSeverity, AlertStatus } from '@prisma/client';
import { IsolationUtil } from '../../utils/isolation.util';

export interface AlertQueryFilters {
  type?: AlertType;
  severity?: AlertSeverity;
  isRead?: boolean;
  status?: AlertStatus;
  search?: string;
  page?: number;
  limit?: number;
}

export class AlertService {
  /**
   * Reconciles inventory stock level to produce or update exactly ONE operational Alert record per (itemId, franchiseId).
   */
  static async reconcileInventoryAlert(itemId: string, tx: any = prisma): Promise<void> {
    const item = await tx.inventoryItem.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        name: true,
        unit: true,
        minimumStock: true,
        franchiseId: true,
        isActive: true,
        category: true,
        vendorId: true,
      },
    });

    if (!item || !item.isActive) {
      // If item is deleted or inactive, resolve any active alert
      const dedupeKey = `INV_${itemId}_${item?.franchiseId || 'HQ'}`;
      await tx.alert.updateMany({
        where: { dedupeKey, status: AlertStatus.ACTIVE },
        data: { status: AlertStatus.RESOLVED, resolvedAt: new Date() },
      });
      return;
    }

    // Compute current stock from movements
    const movements = await tx.stockMovement.findMany({
      where: { itemId },
      select: { quantity: true, baseQty: true },
    });
    const currentStock = movements.reduce(
      (acc: number, m: any) => acc + (m.baseQty !== null && m.baseQty !== undefined ? m.baseQty : m.quantity),
      0
    );

    const threshold = item.minimumStock ?? 0;
    const scopeTag = item.franchiseId || 'HQ';
    const dedupeKey = `INV_${itemId}_${scopeTag}`;
    const metadata = {
      itemName: item.name,
      category: item.category,
      minimumStock: threshold,
      unit: item.unit,
      vendorId: item.vendorId,
    };

    if (currentStock <= 0) {
      // CRITICAL Out of stock condition
      const title = `${item.name} is out of stock`;
      const message = `0 ${item.unit || 'units'} available. Minimum required: ${threshold} ${item.unit || 'units'}.`;

      await tx.alert.upsert({
        where: { dedupeKey },
        create: {
          dedupeKey,
          type: AlertType.INVENTORY,
          severity: AlertSeverity.CRITICAL,
          status: AlertStatus.ACTIVE,
          title,
          message,
          isRead: false,
          entityId: item.id,
          entityType: 'InventoryItem',
          franchiseId: item.franchiseId,
          metadata,
        },
        update: {
          severity: AlertSeverity.CRITICAL,
          status: AlertStatus.ACTIVE,
          title,
          message,
          metadata,
          isRead: false, // Reset unread on reactivation / status change
          resolvedAt: null,
        },
      });
    } else if (currentStock <= threshold) {
      // WARNING Low stock condition
      const title = `${item.name} is running low`;
      const message = `${currentStock} ${item.unit || 'units'} available. Minimum required: ${threshold} ${item.unit || 'units'}.`;

      await tx.alert.upsert({
        where: { dedupeKey },
        create: {
          dedupeKey,
          type: AlertType.INVENTORY,
          severity: AlertSeverity.WARNING,
          status: AlertStatus.ACTIVE,
          title,
          message,
          isRead: false,
          entityId: item.id,
          entityType: 'InventoryItem',
          franchiseId: item.franchiseId,
          metadata,
        },
        update: {
          severity: AlertSeverity.WARNING,
          status: AlertStatus.ACTIVE,
          title,
          message,
          metadata,
          isRead: false, // Reset unread on reactivation / status change
          resolvedAt: null,
        },
      });
    } else {
      // Stock is healthy (> threshold) — resolve existing alert if active
      await tx.alert.updateMany({
        where: { dedupeKey, status: AlertStatus.ACTIVE },
        data: { status: AlertStatus.RESOLVED, resolvedAt: new Date() },
      });
    }
  }

  /**
   * Reconciles FranchiseOrder status to produce or update exactly ONE operational Alert record per order.
   */
  static async reconcileOrderAlert(orderId: string, tx: any = prisma): Promise<void> {
    const order = await tx.franchiseOrder.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        totalAmount: true,
        franchiseId: true,
      },
    });

    if (!order) return;

    const scopeTag = order.franchiseId || 'HQ';
    const dedupeKey = `ORD_${orderId}_${scopeTag}`;

    if (['PENDING', 'APPROVED', 'DISPATCHED'].includes(order.status)) {
      let severity: AlertSeverity = AlertSeverity.WARNING;
      let title = `Order #${order.orderNumber} Pending Approval`;
      let message = `Order #${order.orderNumber} is waiting for HQ approval (Total: ₹${order.totalAmount}).`;

      if (order.status === 'APPROVED') {
        title = `Order #${order.orderNumber} Approved by HQ`;
        message = `Order has been approved by HQ (Total: ₹${order.totalAmount}).`;
      } else if (order.status === 'DISPATCHED') {
        severity = AlertSeverity.INFO;
        title = `Shipment #${order.orderNumber} in Transit`;
        message = `Shipment #${order.orderNumber} is in transit from Central HQ (Total: ₹${order.totalAmount}).`;
      }

      await tx.alert.upsert({
        where: { dedupeKey },
        create: {
          dedupeKey,
          type: AlertType.ORDER,
          severity,
          status: AlertStatus.ACTIVE,
          title,
          message,
          isRead: false,
          entityId: order.id,
          entityType: 'FranchiseOrder',
          franchiseId: order.franchiseId,
        },
        update: {
          severity,
          status: AlertStatus.ACTIVE,
          title,
          message,
          isRead: false, // Reset unread on reactivation / status change
          resolvedAt: null,
        },
      });
    } else {
      // COMPLETED or CANCELLED -> resolve alert
      await tx.alert.updateMany({
        where: { dedupeKey, status: AlertStatus.ACTIVE },
        data: { status: AlertStatus.RESOLVED, resolvedAt: new Date() },
      });
    }
  }

  /**
   * Reconciles all active inventory items and franchise orders for initial seeding / background sync.
   */
  static async reconcileAllActiveConditions(franchiseId?: string): Promise<void> {
    const items = await prisma.inventoryItem.findMany({
      where: {
        isActive: true,
        ...(franchiseId ? { franchiseId } : {}),
      },
      select: { id: true },
    });

    for (const item of items) {
      await this.reconcileInventoryAlert(item.id);
    }

    const orders = await prisma.franchiseOrder.findMany({
      where: {
        status: { in: ['PENDING', 'APPROVED', 'DISPATCHED'] },
        ...(franchiseId ? { franchiseId } : {}),
      },
      select: { id: true },
    });

    for (const order of orders) {
      await this.reconcileOrderAlert(order.id);
    }
  }

  /**
   * Formulates Prisma scope filter according to user role and optional franchise query.
   */
  static getScopeFilter(user: any, requestedFranchiseId?: string) {
    if (user.role === 'SUPER_ADMIN') {
      if (requestedFranchiseId) {
        return { franchiseId: requestedFranchiseId };
      }
      // HQ view: HQ specific alerts (null or HQ franchise id)
      return { OR: [{ franchiseId: null }, { franchise: { isHQ: true } }] };
    }

    const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
    return franchiseFilter;
  }

  /**
   * Queries paginated, filtered alerts directly from the database.
   */
  static async getAlerts(user: any, query: AlertQueryFilters & { franchiseId?: string }) {
    const scopeFilter = this.getScopeFilter(user, query.franchiseId);

    const statusFilter = query.status || AlertStatus.ACTIVE;
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 20));
    const skip = (page - 1) * limit;

    const where: any = {
      AND: [
        scopeFilter,
        { status: statusFilter },
        ...(query.type ? [{ type: query.type }] : []),
        ...(query.severity ? [{ severity: query.severity }] : []),
        ...(query.isRead !== undefined ? [{ isRead: String(query.isRead) === 'true' }] : []),
        ...(query.search
          ? [
              {
                OR: [
                  { title: { contains: query.search, mode: 'insensitive' } },
                  { message: { contains: query.search, mode: 'insensitive' } },
                ],
              },
            ]
          : []),
      ],
    };

    const [rawItems, total] = await Promise.all([
      prisma.alert.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip,
        take: limit,
      }),
      prisma.alert.count({ where }),
    ]);

    const isFranchise = user.role !== 'SUPER_ADMIN' && Boolean(user.franchiseId);

    const data = await Promise.all(
      rawItems.map(async (a) => {
        let actionLabel = (a as any).actionLabel;
        let actionHref = (a as any).actionHref;
        let meta = (a.metadata as any) || {};
        let category = meta.category;
        let vendorId = meta.vendorId;
        let itemName = meta.itemName;
        let minStock = meta.minimumStock;

        if (a.type === AlertType.INVENTORY) {
          if ((!category || vendorId === undefined || !itemName) && a.entityId) {
            const item = await prisma.inventoryItem.findUnique({
              where: { id: a.entityId },
              select: { category: true, vendorId: true, name: true, minimumStock: true },
            });
            if (item) {
              category = item.category;
              vendorId = item.vendorId;
              itemName = item.name;
              minStock = item.minimumStock;
            }
          }

          if (isFranchise) {
            actionLabel = 'Order from HQ';
            actionHref = '/franchise/requests';
          } else {
            // Authoritative Procurement vs Production Resolution
            const isPurchasable = vendorId !== null || category === 'RAW_MATERIAL' || category === 'PACKAGING';
            const isManufactured = (category === 'FINISHED_GOOD' || category === 'SEMI_FINISHED') && !vendorId;

            if (isPurchasable) {
              actionLabel = 'Reorder';
              const targetQty = minStock ?? 0;
              actionHref = `/purchases/new?materialId=${encodeURIComponent(a.entityId || '')}&qty=${encodeURIComponent(targetQty)}`;
            } else if (isManufactured) {
              const targetName = itemName || a.title;
              actionLabel = 'Start Production';
              actionHref = `/production?productName=${encodeURIComponent(targetName)}`;
            } else {
              actionLabel = undefined;
              actionHref = undefined;
            }
          }
        } else if (a.type === AlertType.ORDER) {
          if (isFranchise) {
            if (a.title.includes('Shipment')) {
              actionLabel = 'Receive Stock';
              actionHref = `/franchise/requests?orderId=${encodeURIComponent(a.entityId || '')}`;
            } else {
              actionLabel = 'View Order';
              actionHref = '/franchise/requests';
            }
          } else {
            actionLabel = 'Review Order';
            actionHref = '/franchise/orders';
          }
        }

        return {
          ...a,
          actionLabel,
          actionHref,
          metadata: {
            ...meta,
            category,
          },
        };
      })
    );

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  /**
   * Retrieves aggregated count summary matching current user scope for ACTIVE alerts.
   */
  static async getSummary(user: any, requestedFranchiseId?: string) {
    const scopeFilter = this.getScopeFilter(user, requestedFranchiseId);

    const activeWhere = {
      AND: [scopeFilter, { status: AlertStatus.ACTIVE }],
    };

    // Calculate role-specific pending actions count
    const isFranchise = user.role !== 'SUPER_ADMIN' && Boolean(user.franchiseId);
    let pendingActionsCount = 0;

    if (isFranchise) {
      pendingActionsCount = await prisma.franchiseOrder.count({
        where: {
          franchiseId: user.franchiseId,
          status: { in: ['PENDING', 'DISPATCHED'] },
        },
      });
    } else {
      pendingActionsCount = await prisma.franchiseOrder.count({
        where: {
          status: 'PENDING',
        },
      });
    }

    const [totalActive, unreadCount, outOfStockCount, runningLowCount] = await Promise.all([
      prisma.alert.count({ where: activeWhere }),
      prisma.alert.count({
        where: { AND: [scopeFilter, { status: AlertStatus.ACTIVE, isRead: false }] },
      }),
      prisma.alert.count({
        where: { AND: [scopeFilter, { status: AlertStatus.ACTIVE, severity: AlertSeverity.CRITICAL }] },
      }),
      prisma.alert.count({
        where: { AND: [scopeFilter, { status: AlertStatus.ACTIVE, severity: AlertSeverity.WARNING }] },
      }),
    ]);

    return {
      needsAttention: totalActive,
      unreadCount,
      outOfStockCount,
      runningLowCount,
      pendingActionsCount,
      // Backward compatibility fields
      totalActive,
      criticalCount: outOfStockCount,
      inventoryCount: outOfStockCount + runningLowCount,
      orderCount: pendingActionsCount,
      paymentCount: 0,
      dispatchCount: 0,
      systemCount: 0,
    };
  }

  /**
   * Marks a specific alert as read without changing its ACTIVE/RESOLVED status.
   */
  static async markAsRead(alertId: string, user: any): Promise<boolean> {
    const scopeFilter = this.getScopeFilter(user);

    const alert = await prisma.alert.findFirst({
      where: {
        AND: [scopeFilter, { id: alertId }],
      },
    });

    if (!alert) return false;

    await prisma.alert.update({
      where: { id: alertId },
      data: { isRead: true },
    });

    return true;
  }

  /**
   * Marks all ACTIVE alerts as read for the current user scope.
   */
  static async markAllAsRead(user: any, requestedFranchiseId?: string): Promise<number> {
    const scopeFilter = this.getScopeFilter(user, requestedFranchiseId);

    const result = await prisma.alert.updateMany({
      where: {
        AND: [scopeFilter, { status: AlertStatus.ACTIVE, isRead: false }],
      },
      data: { isRead: true },
    });

    return result.count;
  }
}

