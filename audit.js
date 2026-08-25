const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function audit() {
  const tables = [
    'inventoryItem',
    'inventoryBatch',
    'procurementOrder',
    'procurementOrderItem',
    'goodsReceipt',
    'goodsReceiptItem',
    'recipe',
    'recipeItem',
    'production',
    'productionItem'
  ];

  for (const t of tables) {
    if (prisma[t]) {
      const row = await prisma[t].findFirst();
      console.log(`--- ${t} ---`);
      if (row) {
        console.log(Object.keys(row)
          .filter(k => /qty|quantity|amount|unit|stock|price/i.test(k))
          .map(k => `${k}: ${row[k]}`)
          .join('\n'));
        if (t === 'procurementOrder' && row.items) {
           console.log(`items JSON: ${JSON.stringify(row.items).substring(0, 200)}`);
        }
      } else {
        console.log('Empty');
      }
    }
  }
}

audit().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
