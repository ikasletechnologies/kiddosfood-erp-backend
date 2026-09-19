import fs from 'fs';

function inspect() {
  const siPath = 'd:/erpkiddos/erp-frontend/kiddosfood-erp-frontend/src/app/sales/invoices/SalesInvoicesClient.tsx';
  const lines = fs.readFileSync(siPath, 'utf8').split('\n');
  console.log(lines.slice(1940, 1970).join('\n'));
}

inspect();
