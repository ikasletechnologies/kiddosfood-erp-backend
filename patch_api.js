const fs = require('fs');

function fixApi(file) {
  let code = fs.readFileSync(file, 'utf8');
  code = code.replace(/import \{ accountingApi \} from "@\/lib\/api\/accounting\.api";/, 'import { reportsApi } from "@/lib/api/accounting.api";');
  code = code.replace(/accountingApi\s*\.getExpenseCategory/, 'reportsApi.getExpenseCategory');
  code = code.replace(/accountingApi\s*\.getExpenseItem/, 'reportsApi.getExpenseItem');
  fs.writeFileSync(file, code);
}

fixApi('../erp-frontend/src/app/reports/components/ExpenseCategoryReport.tsx');
fixApi('../erp-frontend/src/app/reports/components/ExpenseItemReport.tsx');

console.log('done');
