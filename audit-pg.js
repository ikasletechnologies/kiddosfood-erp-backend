const { Client } = require('pg');

const client = new Client({
  connectionString: "postgresql://postgres.kdohpbsqjsxzaqfgnaak:wahid1014129@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true"
});

async function audit() {
  await client.connect();
  const tables = ['"InventoryItem"', '"ProcurementOrder"', '"GoodsReceipt"', '"Recipe"', '"Production"'];
  for (const t of tables) {
    try {
      const res = await client.query(`SELECT * FROM ${t} LIMIT 1`);
      console.log(`--- ${t} ---`);
      if (res.rows.length) {
        const row = res.rows[0];
        console.log(Object.keys(row)
          .filter(k => /qty|quantity|amount|unit|stock|price|items/i.test(k))
          .map(k => `${k}: ${typeof row[k] === 'object' ? JSON.stringify(row[k]) : row[k]}`)
          .join('\n'));
      } else {
        console.log("Empty");
      }
    } catch (e) {
      console.log(`Error querying ${t}: ${e.message}`);
    }
  }
  
  const childTables = ['"ProcurementOrderItem"', '"GoodsReceiptItem"', '"RecipeItem"', '"ProductionItem"'];
  for (const t of childTables) {
    try {
      const res = await client.query(`SELECT * FROM ${t} LIMIT 1`);
      console.log(`--- ${t} ---`);
      if (res.rows.length) {
        const row = res.rows[0];
        console.log(Object.keys(row)
          .filter(k => /qty|quantity|amount|unit|stock|price/i.test(k))
          .map(k => `${k}: ${row[k]}`)
          .join('\n'));
      } else {
        console.log("Empty");
      }
    } catch (e) {
      console.log(`Error querying ${t}: ${e.message}`);
    }
  }
  
  await client.end();
}

audit();
