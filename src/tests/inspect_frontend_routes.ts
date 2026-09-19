import fs from 'fs';

function inspect() {
  const dcPath = 'd:/erpkiddos/erp-frontend/kiddosfood-erp-frontend/src/app/sales/delivery-challan/page.tsx';
  const lines = fs.readFileSync(dcPath, 'utf8').split('\n');
  console.log(lines.slice(435, 480).join('\n'));
}

inspect();
