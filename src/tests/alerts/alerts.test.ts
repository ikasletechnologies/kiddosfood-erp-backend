// @ts-ignore
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import prisma from '../../lib/prisma';
import { AlertService } from '../../modules/alerts/alert.service';
import { AlertType, AlertSeverity, AlertStatus, ItemCategory, StockMovementType } from '@prisma/client';

describe('Authoritative Alert System & Lifecycle Tests', () => {
  let testHqFranchiseId: string;
  let testBranchAId: string;
  let testBranchBId: string;

  let itemNormal: string;
  let itemLow: string;
  let itemZero: string;

  const hqUser = { role: 'SUPER_ADMIN', userId: 'user-hq' };
  const branchAUser = { role: 'FRANCHISE_ADMIN', franchiseId: '', userId: 'user-branch-a' };
  const branchBUser = { role: 'FRANCHISE_ADMIN', franchiseId: '', userId: 'user-branch-b' };

  beforeEach(async () => {
    // Cleanup alerts and test items
    await prisma.alert.deleteMany({});

    // Setup test franchises
    let hqFranchise = await prisma.franchise.findFirst({ where: { isHQ: true } });
    if (!hqFranchise) {
      hqFranchise = await prisma.franchise.create({
        data: {
          name: 'Central HQ Test',
          location: 'HQ Location',
          ownerName: 'HQ Admin',
          contactNum: '9999999999',
          isHQ: true,
        },
      });
    }
    testHqFranchiseId = hqFranchise.id;

    const branchA = await prisma.franchise.create({
      data: {
        name: 'Test Branch A',
        location: 'Branch A Loc',
        ownerName: 'Owner A',
        contactNum: '8888888888',
        isHQ: false,
      },
    });
    testBranchAId = branchA.id;
    branchAUser.franchiseId = testBranchAId;

    const branchB = await prisma.franchise.create({
      data: {
        name: 'Test Branch B',
        location: 'Branch B Loc',
        ownerName: 'Owner B',
        contactNum: '7777777777',
        isHQ: false,
      },
    });
    testBranchBId = branchB.id;
    branchBUser.franchiseId = testBranchBId;
  });

  afterEach(async () => {
    await prisma.alert.deleteMany({});
    if (testBranchAId) await prisma.franchise.delete({ where: { id: testBranchAId } }).catch(() => {});
    if (testBranchBId) await prisma.franchise.delete({ where: { id: testBranchBId } }).catch(() => {});
  });

  it('1. Stock > minimum threshold creates NO active alert', async () => {
    const item = await prisma.inventoryItem.create({
      data: {
        name: 'Healthy Stock Item',
        sku: 'SKU-HEALTHY-1',
        category: ItemCategory.RAW_MATERIAL,
        currentStock: 50,
        minimumStock: 10,
        unit: 'KG',
        franchiseId: testBranchAId,
      },
    });
    await prisma.stockMovement.create({
      data: { itemId: item.id, movementType: StockMovementType.PURCHASE_IN, quantity: 50, baseQty: 50 },
    });

    await AlertService.reconcileInventoryAlert(item.id);

    const activeAlerts = await prisma.alert.findMany({
      where: { entityId: item.id, status: AlertStatus.ACTIVE },
    });
    expect(activeAlerts.length).toBe(0);

    // Cleanup item
    await prisma.stockMovement.deleteMany({ where: { itemId: item.id } });
    await prisma.inventoryItem.delete({ where: { id: item.id } });
  });

  it('2. Stock <= minimum threshold creates LOW_STOCK WARNING alert', async () => {
    const item = await prisma.inventoryItem.create({
      data: {
        name: 'Low Stock Item',
        sku: 'SKU-LOW-1',
        category: ItemCategory.RAW_MATERIAL,
        currentStock: 5,
        minimumStock: 10,
        unit: 'KG',
        franchiseId: testBranchAId,
      },
    });
    await prisma.stockMovement.create({
      data: { itemId: item.id, movementType: StockMovementType.PURCHASE_IN, quantity: 5, baseQty: 5 },
    });

    await AlertService.reconcileInventoryAlert(item.id);

    const alert = await prisma.alert.findUnique({
      where: { dedupeKey: `INV_${item.id}_${testBranchAId}` },
    });
    expect(alert).not.toBeNull();
    expect(alert?.status).toBe(AlertStatus.ACTIVE);
    expect(alert?.severity).toBe(AlertSeverity.WARNING);
    expect(alert?.type).toBe(AlertType.INVENTORY);
    expect(alert?.title).toContain('Low Stock Item is running low');

    // Cleanup item
    await prisma.stockMovement.deleteMany({ where: { itemId: item.id } });
    await prisma.inventoryItem.delete({ where: { id: item.id } });
  });

  it('3. Stock <= 0 creates OUT_OF_STOCK CRITICAL alert and NO duplicate LOW_STOCK alert', async () => {
    const item = await prisma.inventoryItem.create({
      data: {
        name: 'Zero Stock Item',
        sku: 'SKU-ZERO-1',
        category: ItemCategory.RAW_MATERIAL,
        currentStock: 0,
        minimumStock: 10,
        unit: 'KG',
        franchiseId: testBranchAId,
      },
    });

    await AlertService.reconcileInventoryAlert(item.id);

    const alerts = await prisma.alert.findMany({
      where: { entityId: item.id },
    });
    // Exactly ONE operational alert row
    expect(alerts.length).toBe(1);
    expect(alerts[0].severity).toBe(AlertSeverity.CRITICAL);
    expect(alerts[0].status).toBe(AlertStatus.ACTIVE);
    expect(alerts[0].title).toContain('Zero Stock Item is out of stock');

    // Cleanup item
    await prisma.inventoryItem.delete({ where: { id: item.id } });
  });

  it('4. Stock transitions update the same operational alert and resolve when stock recovers', async () => {
    const item = await prisma.inventoryItem.create({
      data: {
        name: 'Transition Item',
        sku: 'SKU-TRANS-1',
        category: ItemCategory.RAW_MATERIAL,
        currentStock: 5,
        minimumStock: 10,
        unit: 'KG',
        franchiseId: testBranchAId,
      },
    });
    const movement1 = await prisma.stockMovement.create({
      data: { itemId: item.id, movementType: StockMovementType.PURCHASE_IN, quantity: 5, baseQty: 5 },
    });

    // Step 1: Stock 5 -> Low Stock Warning
    await AlertService.reconcileInventoryAlert(item.id);
    let alert = await prisma.alert.findUnique({
      where: { dedupeKey: `INV_${item.id}_${testBranchAId}` },
    });
    expect(alert?.severity).toBe(AlertSeverity.WARNING);

    // Step 2: Stock drops to 0 -> Escalates to Critical on SAME record
    await prisma.stockMovement.create({
      data: { itemId: item.id, movementType: StockMovementType.TRANSFER_OUT, quantity: -5, baseQty: -5 },
    });
    await AlertService.reconcileInventoryAlert(item.id);

    const allAlerts = await prisma.alert.findMany({ where: { entityId: item.id } });
    expect(allAlerts.length).toBe(1); // Still exactly ONE row
    expect(allAlerts[0].severity).toBe(AlertSeverity.CRITICAL);

    // Step 3: Stock recovers to 20 -> Alert becomes RESOLVED
    await prisma.stockMovement.create({
      data: { itemId: item.id, movementType: StockMovementType.PURCHASE_IN, quantity: 20, baseQty: 20 },
    });
    await AlertService.reconcileInventoryAlert(item.id);

    alert = await prisma.alert.findUnique({ where: { dedupeKey: `INV_${item.id}_${testBranchAId}` } });
    expect(alert?.status).toBe(AlertStatus.RESOLVED);
    expect(alert?.resolvedAt).not.toBeNull();

    // Cleanup item
    await prisma.stockMovement.deleteMany({ where: { itemId: item.id } });
    await prisma.inventoryItem.delete({ where: { id: item.id } });
  });

  it('5. Mark Read sets isRead=true but DOES NOT resolve the alert status', async () => {
    const item = await prisma.inventoryItem.create({
      data: {
        name: 'Unread Alert Item',
        sku: 'SKU-UNREAD-1',
        category: ItemCategory.RAW_MATERIAL,
        currentStock: 2,
        minimumStock: 10,
        unit: 'KG',
        franchiseId: testBranchAId,
      },
    });
    await prisma.stockMovement.create({
      data: { itemId: item.id, movementType: StockMovementType.PURCHASE_IN, quantity: 2, baseQty: 2 },
    });
    await AlertService.reconcileInventoryAlert(item.id);

    const alertBefore = await prisma.alert.findUnique({
      where: { dedupeKey: `INV_${item.id}_${testBranchAId}` },
    });
    expect(alertBefore?.isRead).toBe(false);

    // Mark as Read
    const markResult = await AlertService.markAsRead(alertBefore!.id, branchAUser);
    expect(markResult).toBe(true);

    const alertAfter = await prisma.alert.findUnique({ where: { id: alertBefore!.id } });
    expect(alertAfter?.isRead).toBe(true);
    expect(alertAfter?.status).toBe(AlertStatus.ACTIVE); // READ != RESOLVED

    // Cleanup item
    await prisma.stockMovement.deleteMany({ where: { itemId: item.id } });
    await prisma.inventoryItem.delete({ where: { id: item.id } });
  });

  it('6. Multi-tenant Scope Isolation: Branch A cannot see Branch B alerts', async () => {
    const itemA = await prisma.inventoryItem.create({
      data: { name: 'Item Branch A', sku: 'SKU-A-1', category: ItemCategory.RAW_MATERIAL, currentStock: 1, minimumStock: 10, unit: 'KG', franchiseId: testBranchAId },
    });
    await prisma.stockMovement.create({ data: { itemId: itemA.id, movementType: StockMovementType.PURCHASE_IN, quantity: 1, baseQty: 1 } });
    await AlertService.reconcileInventoryAlert(itemA.id);

    const itemB = await prisma.inventoryItem.create({
      data: { name: 'Item Branch B', sku: 'SKU-B-1', category: ItemCategory.RAW_MATERIAL, currentStock: 1, minimumStock: 10, unit: 'KG', franchiseId: testBranchBId },
    });
    await prisma.stockMovement.create({ data: { itemId: itemB.id, movementType: StockMovementType.PURCHASE_IN, quantity: 1, baseQty: 1 } });
    await AlertService.reconcileInventoryAlert(itemB.id);

    // Branch A query
    const resA = await AlertService.getAlerts(branchAUser, {});
    expect(resA.total).toBe(1);
    expect(resA.data[0].franchiseId).toBe(testBranchAId);

    // Branch B query
    const resB = await AlertService.getAlerts(branchBUser, {});
    expect(resB.total).toBe(1);
    expect(resB.data[0].franchiseId).toBe(testBranchBId);

    // Summary counts
    const sumA = await AlertService.getSummary(branchAUser);
    expect(sumA.inventoryCount).toBe(1);

    // Cleanup
    await prisma.stockMovement.deleteMany({ where: { itemId: { in: [itemA.id, itemB.id] } } });
    await prisma.inventoryItem.deleteMany({ where: { id: { in: [itemA.id, itemB.id] } } });
  });

  it('7. Concurrency / Idempotency: Simultaneous reconciliation produces exactly ONE alert row', async () => {
    const item = await prisma.inventoryItem.create({
      data: { name: 'Concurrent Item', sku: 'SKU-CONC-1', category: ItemCategory.RAW_MATERIAL, currentStock: 0, minimumStock: 10, unit: 'KG', franchiseId: testBranchAId },
    });

    // Run 5 simultaneous reconciliation tasks
    await Promise.all([
      AlertService.reconcileInventoryAlert(item.id),
      AlertService.reconcileInventoryAlert(item.id),
      AlertService.reconcileInventoryAlert(item.id),
      AlertService.reconcileInventoryAlert(item.id),
      AlertService.reconcileInventoryAlert(item.id),
    ]);

    const alerts = await prisma.alert.findMany({ where: { entityId: item.id } });
    expect(alerts.length).toBe(1);

    // Cleanup
    await prisma.inventoryItem.delete({ where: { id: item.id } });
  });

  it('8. Purchasable Raw Material alert yields Reorder action href for HQ', async () => {
    const rawItem = await prisma.inventoryItem.create({
      data: { name: 'Raw Flour', sku: 'SKU-FLOUR-1', category: ItemCategory.RAW_MATERIAL, currentStock: 0, minimumStock: 10, unit: 'KG', franchiseId: null },
    });
    await AlertService.reconcileInventoryAlert(rawItem.id);

    const res = await AlertService.getAlerts(hqUser, {});
    const alert = res.data.find(a => a.entityId === rawItem.id);
    expect(alert).toBeDefined();
    expect(alert?.actionLabel).toBe('Reorder');
    expect(alert?.actionHref).toContain('/purchases/new?materialId=');

    // Cleanup
    await prisma.inventoryItem.delete({ where: { id: rawItem.id } });
  });

  it('9. Manufactured Finished Good alert yields Start Production action href for HQ', async () => {
    const fgItem = await prisma.inventoryItem.create({
      data: { name: 'ALL IN ONE BLEND(40 INGREDIENTS)', sku: 'SKU-BLEND-1', category: ItemCategory.FINISHED_GOOD, currentStock: 0, minimumStock: 10, unit: 'PC', franchiseId: null },
    });
    await AlertService.reconcileInventoryAlert(fgItem.id);

    const res = await AlertService.getAlerts(hqUser, {});
    const alert = res.data.find(a => a.entityId === fgItem.id);
    expect(alert).toBeDefined();
    expect(alert?.actionLabel).toBe('Start Production');
    expect(alert?.actionHref).toContain('/production?productName=');

    // Cleanup
    await prisma.inventoryItem.delete({ where: { id: fgItem.id } });
  });
});
