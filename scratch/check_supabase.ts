import { Client } from 'pg';

async function main() {
  const client = new Client({
    connectionString: 'postgresql://postgres.kdohpbsqjsxzaqfgnaak:wahid1014129@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true'
  });
  await client.connect();
  try {
    const res = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'Vendor'");
    console.log('Columns in Supabase Vendor table:', res.rows.map(r => r.column_name));
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await client.end();
  }
}

main();
