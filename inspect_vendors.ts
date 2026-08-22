import { ProcurementService } from './src/modules/procurement/procurement.service';

async function main() {
  const result = await ProcurementService.getVendors();
  console.log('GET VENDORS RESULT:');
  console.log(JSON.stringify(result, null, 2));
}

main().catch(console.error).finally(() => process.exit(0));
