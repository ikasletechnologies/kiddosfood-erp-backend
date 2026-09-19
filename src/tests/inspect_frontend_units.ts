import fs from 'fs';

function inspect() {
  const siPath = 'd:/erpkiddos/erp-frontend/kiddosfood-erp-frontend/src/app/sales/invoices/SalesInvoicesClient.tsx';
  if (fs.existsSync(siPath)) {
    const lines = fs.readFileSync(siPath, 'utf8').split('\n');
    console.log(lines.slice(570, 615).join('\n'));
  }
}

inspect();
