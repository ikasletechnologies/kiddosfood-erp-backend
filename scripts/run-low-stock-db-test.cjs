require('dotenv').config();
const {Client}=require('pg'),{spawnSync}=require('child_process');
const database='kiddos_low_stock_test',original=new URL(process.env.DATABASE_URL || '');
if(!['localhost','127.0.0.1','[::1]'].includes(original.hostname))throw Error('This test runner requires a local PostgreSQL server.');
if(original.pathname==='/'+database)throw Error('Do not launch this runner from the test database itself.');
const client=new Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000});
let created=false;
(async()=>{
 await client.connect();
 if((await client.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount)throw Error('Test database already exists. It will not be changed.');
 await client.query('CREATE DATABASE "kiddos_low_stock_test"');created=true;
 const testUrl=new URL(original);testUrl.hostname='127.0.0.1';testUrl.pathname='/'+database;
 const env={...process.env,DATABASE_URL:testUrl.toString(),DIRECT_URL:testUrl.toString(),KIDDOS_LOW_STOCK_TEST_DB:'1'};
 const run=(args)=>{const result=spawnSync(process.execPath,args,{env,stdio:'inherit'});if(result.status!==0)throw Error('Test command failed: '+args[0]);};
 run(['node_modules/prisma/build/index.js','db','push']);
 run(['node_modules/tsx/dist/cli.mjs','--test','src/tests/franchise/finished-goods-low-stock.integration.test.ts']);
})().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(async()=>{
 if(created){
  // Only the exact fresh database created by this invocation is eligible.
  if(database!=='kiddos_low_stock_test'||original.pathname==='/'+database)throw Error('Unsafe test database cleanup');
  await client.query('DROP DATABASE "kiddos_low_stock_test" WITH (FORCE)');
  console.log('Disposable test database removed; ERP database records were not changed.');
 }
 await client.end();
});

