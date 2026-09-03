const fs = require('fs');
let code = fs.readFileSync('../erp-frontend/src/app/reports/components/ExpenseItemReport.tsx', 'utf8');

code = code.replace(/accountingApi/g, 'reportsApi');
code = code.replace(/reportsApi\s*\.\s*getExpenses/g, 'reportsApi.getExpenseItem');
code = code.replace(/setExpenses\(res\.data\?\.expenses \|\| \[\]\);/g, 'setExpenses(res.data || []);');

fs.writeFileSync('../erp-frontend/src/app/reports/components/ExpenseItemReport.tsx', code);
console.log('done');
