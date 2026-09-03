const fs = require('fs');
let code = fs.readFileSync('../erp-frontend/src/app/reports/page.tsx', 'utf8');
code = code.replace(
  /{!isTaxComplianceReport && \(/,
  '{!isTaxComplianceReport && !activeChild?.id.includes("Expense") && !activeChild?.id.includes("Party") && !activeChild?.id.includes("All Parties") && !activeChild?.id.includes("Sale Purchase By Party") && ('
);
fs.writeFileSync('../erp-frontend/src/app/reports/page.tsx', code);
console.log('done');
