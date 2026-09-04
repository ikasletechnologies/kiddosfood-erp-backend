const fs = require('fs');
let code = fs.readFileSync('src/modules/finance/finance.service.ts', 'utf8');
code = code.replace(/static async getExpenseItemReportData.*?return this\.getExpensesReportData.*?}/s, `static async getExpenseItemReportData(franchiseIdOrFilters?: any, startDateParam?: string, endDateParam?: string, categoryParam?: string) {
    const { franchiseId, startDate, endDate, category } = normalizeReportFilters(franchiseIdOrFilters, startDateParam, endDateParam, categoryParam);
    const { start, end } = parseInclusiveDates(startDate, endDate);
    const where: any = {
      ...(franchiseId ? { franchiseId } : {}),
      isCancelled: false,
      purchaseOrderId: { not: null }
    };
    if (start || end) {
      where.date = {
        ...(start ? { gte: start } : {}),
        ...(end ? { lte: end } : {})
      };
    }
    if (category) where.category = category;

    const expenses = await prisma.expense.findMany({
      where,
      include: { 
        purchaseOrder: {
          include: {
            poItems: { include: { inventoryItem: true } }
          }
        }
      },
      orderBy: { date: 'desc' }
    });

    const items: any[] = [];
    for (const exp of expenses) {
      if (exp.purchaseOrder && (exp.purchaseOrder as any).poItems) {
        for (const item of (exp.purchaseOrder as any).poItems) {
          items.push({
            id: item.id || Math.random().toString(),
            date: exp.date,
            expenseNumber: exp.expenseNumber,
            category: exp.category,
            expenseItem: item.inventoryItem?.name || item.itemName || 'Unknown Item',
            quantity: item.quantity,
            unitRate: item.price,
            amount: item.total || (item.quantity * item.price)
          });
        }
      }
    }

    return { expenses: items };
  }`);
fs.writeFileSync('src/modules/finance/finance.service.ts', code);
console.log('done');
