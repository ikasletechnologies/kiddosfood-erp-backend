const fs = require('fs');
let code = fs.readFileSync('../erp-frontend/src/app/reports/components/ExpenseItemReport.tsx', 'utf8');
code = code.replace(/e\.description/g, 'e.expenseItem');
fs.writeFileSync('../erp-frontend/src/app/reports/components/ExpenseItemReport.tsx', code);
console.log('done');
