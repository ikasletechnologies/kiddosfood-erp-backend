const { Client } = require('pg');

async function main() {
  const client = new Client({
    connectionString: "postgresql://food_admin:food_password@localhost:5432/food_erp_db"
  });

  try {
    await client.connect();
    
    const res = await client.query('SELECT count(*) FROM "Customer"');
    console.log('LOCAL DB Customer count:', res.rows[0].count);
    
    if (res.rows[0].count > 0) {
      const customers = await client.query('SELECT * FROM "Customer" LIMIT 5');
      console.log('LOCAL DB Customers:', customers.rows.map(c => c.name));
    }
  } catch (err) {
    console.error('Error connecting to local DB:', err.message);
  } finally {
    await client.end();
  }
}

main();
