import prisma from '../../lib/prisma';
import { Prisma } from '@prisma/client';

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

    // Compute low stock raw items in-memory using canonical stock vs minimumStock.
    // Phase 4 established that InventoryItem.currentStock is always in the item's
    // configured canonical unit — no SKU-parsing hack needed.
    const lowStockRawItems = inventoryItems.filter(item => {
      return item.currentStock <= item.minimumStock;
    });

    // Build Low Stock raw materials and finished goods list
    const lowStockList: Array<{ id: string; name: string; product: string; currentStock: number; current: number; required: number; unit: string; status: string; action: string }> = lowStockRawItems.map(item => {
      const physicalStock = item.currentStock; // already canonical
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
        name: item.name,
        product: item.name,
        currentStock: physicalStock,
        current: physicalStock,
        required: item.minimumStock,
        unit: displayUnit || 'KG',
        status,
        action: physicalStock <= 0 ? 'Request Refill' : 'Reorder'
      };
    });

    for (const batch of productBatches) {
      if (batch.quantity <= 10) {
        lowStockList.push({
          id: batch.id,
          name: batch.product?.name || 'Finished Good',
          product: batch.product?.name || 'Finished Good',
          currentStock: batch.quantity,
          current: batch.quantity,
          required: 10,
          unit: batch.product?.sku || 'PC',
          status: batch.quantity <= 0 ? 'RED' : 'YELLOW',
          action: batch.quantity <= 0 ? 'Request Refill' : 'Reorder'
        });
      }
    }

    return {
      inventoryValue,
      inventoryItemCount: inventoryItems.length,
      lowStockCount: lowStockRawItems.length + lowStockBatchCount,
      inventoryAlerts: inventoryAlerts.slice(0, 10), // Limit dashboard view
      lowStockAlerts: lowStockList.slice(0, 10),
      lowStock: lowStockList.slice(0, 10)
    };
  }
}
