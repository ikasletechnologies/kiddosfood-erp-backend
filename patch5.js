const fs = require('fs');
let code = fs.readFileSync('../erp-frontend/src/app/reports/components/ExpenseItemReport.tsx', 'utf8');
code = code.replace(/"itemName"/g, '"expenseItem"');
code = code.replace(/"unitPrice"/g, '"unitRate"');
fs.writeFileSync('../erp-frontend/src/app/reports/components/ExpenseItemReport.tsx', code);
console.log('done');
