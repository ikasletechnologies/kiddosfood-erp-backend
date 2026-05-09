import { Client } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL
  });
  await client.connect();
  try {
    const res = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'Vendor'");
    console.log('Columns in Vendor table:', res.rows.map(r => r.column_name));
    
    const res2 = await client.query("SELECT * FROM \"Vendor\" LIMIT 1");
    console.log('Sample row from Vendor:', res2.rows[0]);
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await client.end();
  }
}

main();
