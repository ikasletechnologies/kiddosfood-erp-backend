import prisma from '../../lib/prisma';
import { Prisma } from '@prisma/client';
import { getStockInPhysicalUnit } from '../inventory/inventory.service';

export class DashboardInventoryService {
  static async getInventoryStats(franchiseId?: string) {
    const itemWhere: Prisma.InventoryItemWhereInput = franchiseId ? { franchiseId } : {};
    const batchWhere: Prisma.ProductBatchWhereInput = franchiseId ? { franchiseId } : {};

    const [inventoryItems, productBatches, lowStockBatchCount] = await Promise.all([
      // franchise relation was fetched but never read below — dropped to
      // avoid the join.
      prisma.inventoryItem.findMany({ where: itemWhere }),
      // Only the soonest-expiring 50 are ever shown (sliced to 10 below) —
      // previously this pulled every batch with an expiry date ever
      // created, unbounded and growing forever. lowStockCount below needs
      // the true count across ALL batches, not just this page, so that's a
      // separate DB-side count() rather than derived from this bounded list.
      prisma.productBatch.findMany({
        where: {
          ...batchWhere,
          expiryDate: { not: null }
        },
        include: { product: true },
        orderBy: { expiryDate: 'asc' },
        take: 50
      }),
      prisma.productBatch.count({ where: { ...batchWhere, expiryDate: { not: null }, quantity: { lte: 10 } } })
    ]);

    // Calculate inventory valuation
    const inventoryValue = inventoryItems.reduce(
      (sum, item) => sum + (item.currentStock * (item.costPrice || item.basePrice || 0)),
      0
    );

    // Build Inventory Alerts (finished goods / batches)
    const inventoryAlerts = productBatches.map(batch => {
      const currentStock = batch.quantity;
      const minStock = 10; // Default minimum stock threshold for finished goods
      
      let status = 'GREEN';
      if (currentStock <= 0) {
        status = 'RED';
      } else if (currentStock <= minStock) {
        status = 'YELLOW';
      }

      let daysLeft = 'N/A';
      if (batch.expiryDate) {
        const diffTime = new Date(batch.expiryDate).getTime() - Date.now();
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        daysLeft = diffDays > 0 ? `${diffDays} days` : 'Expired';
      }

      return {
        id: batch.id,
        productName: batch.product?.name || 'Unknown Product',
        currentStock,
        unit: batch.product?.sku || 'Units',
        expiryDate: batch.expiryDate ? new Date(batch.expiryDate).toLocaleDateString() : 'No Expiry',
        daysLeft,
        status,
        refillSuggestion: status === 'RED' ? 'Refill Urgent' : status === 'YELLOW' ? 'Reorder Soon' : 'Safe'
      };
    });

    // Compute low stock raw items in-memory using physicalStock compared to minimumStock
    const lowStockRawItems = inventoryItems.filter(item => {
      const physicalStock = getStockInPhysicalUnit(item.currentStock, item.sku, item.category);
      return physicalStock <= item.minimumStock;
    });

    // Build Low Stock raw materials list
    const lowStockAlerts = lowStockRawItems.map(item => {
      const physicalStock = getStockInPhysicalUnit(item.currentStock, item.sku, item.category);
      let status = 'GREEN';
      if (physicalStock <= 0) {
        status = 'RED';
      } else if (physicalStock <= item.minimumStock) {
        status = 'YELLOW';
      }

      const parts = item.sku ? item.sku.split('-') : [];
      const sizePart = parts.length >= 2 ? parts[parts.length - 1] : "";
      const match = sizePart.match(/^(\d+(?:\.\d+)?)\s*([A-Z]+)$/i);
      const displayUnit = (item.category === 'FINISHED_GOOD' && match) ? match[2].toUpperCase() : item.unit;

      return {
        id: item.id,
        product: item.name,
        current: physicalStock,
        required: item.minimumStock,
        unit: displayUnit,
        status,
        action: physicalStock <= 0 ? 'Request Refill' : 'Monitor'
      };
    });

    return {
      inventoryValue,
      inventoryItemCount: inventoryItems.length,
      lowStockCount: lowStockRawItems.length + lowStockBatchCount,
      inventoryAlerts: inventoryAlerts.slice(0, 10), // Limit dashboard view
      lowStockAlerts: lowStockAlerts.slice(0, 10)
    };
  }
}
