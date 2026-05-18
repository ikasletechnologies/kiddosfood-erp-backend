import prisma from '../../lib/prisma';
import { Prisma } from '@prisma/client';

export class DashboardInventoryService {
  static async getInventoryStats(franchiseId?: string) {
    const itemWhere: Prisma.InventoryItemWhereInput = franchiseId ? { franchiseId } : {};
    const batchWhere: Prisma.ProductBatchWhereInput = franchiseId ? { franchiseId } : {};

    const [inventoryItems, lowStockRawItems, productBatches] = await Promise.all([
      prisma.inventoryItem.findMany({
        where: itemWhere,
        include: { franchise: true }
      }),
      prisma.inventoryItem.findMany({
        where: {
          ...itemWhere,
          currentStock: { lte: 10 }
        }
      }),
      prisma.productBatch.findMany({
        where: {
          ...batchWhere,
          expiryDate: { not: null }
        },
        include: { product: true }
      })
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

    // Build Low Stock raw materials list
    const lowStockAlerts = lowStockRawItems.map(item => {
      let status = 'GREEN';
      if (item.currentStock <= 0) {
        status = 'RED';
      } else if (item.currentStock <= item.minimumStock) {
        status = 'YELLOW';
      }

      return {
        id: item.id,
        product: item.name,
        current: item.currentStock,
        required: item.minimumStock,
        unit: item.unit,
        status,
        action: item.currentStock <= 0 ? 'Request Refill' : 'Monitor'
      };
    });

    return {
      inventoryValue,
      inventoryItemCount: inventoryItems.length,
      lowStockCount: lowStockRawItems.length + productBatches.filter(b => b.quantity <= 10).length,
      inventoryAlerts: inventoryAlerts.slice(0, 10), // Limit dashboard view
      lowStockAlerts: lowStockAlerts.slice(0, 10)
    };
  }
}
