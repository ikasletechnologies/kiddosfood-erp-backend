import fs from 'fs';
import path from 'path';

const frontendOrderPage = 'D:/erpkiddos/erp-frontend/kiddosfood-erp-frontend/src/app/sales/orders/page.tsx';
if (fs.existsSync(frontendOrderPage)) {
  const content = fs.readFileSync(frontendOrderPage, 'utf8');
  console.log('File length:', content.length);
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    if (line.includes('convertToSale') || line.includes('handleConfirm') || line.includes('Create Proforma') || line.includes('handleCreateProforma')) {
      console.log(`${idx + 1}: ${line}`);
    }
  });
} else {
  console.log('File does not exist at:', frontendOrderPage);
}
