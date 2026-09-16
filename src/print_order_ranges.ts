import fs from 'fs';

const file = 'D:/erpkiddos/erp-frontend/kiddosfood-erp-frontend/src/app/sales/orders/page.tsx';
const lines = fs.readFileSync(file, 'utf8').split('\n');

function printRange(start: number, end: number) {
  console.log(`--- Lines ${start} to ${end} ---`);
  for (let i = start - 1; i < end && i < lines.length; i++) {
    console.log(`${i + 1}: ${lines[i]}`);
  }
}

printRange(785, 875);
printRange(1580, 1630);
printRange(1900, 1945);
