const fs = require('fs');
let code = fs.readFileSync('../erp-frontend/src/app/reports/components/ExpenseCategoryReport.tsx', 'utf8');

// Replace state and fetch function
code = code.replace(
  /const \[expenses, setExpenses\] = useState<Expense\[\]>\(\[\]\);.*?useEffect\(\(\) => \{/s,
  `const [categoryRows, setCategoryRows] = useState<any[]>([]);
  const [totalExpense, setTotalExpense] = useState<number>(0);
  const [fetching, setFetching] = useState(false);

  const fetchExpenses = () => {
    setFetching(true);
    accountingApi
      .getExpenseCategory({
        startDate,
        endDate,
      })
      .then((res: any) => {
        setCategoryRows(res.data?.categoryBreakdown || []);
        setTotalExpense(res.data?.summary?.totalExpenses || 0);
      })
      .catch(() => {
        toast.error("Failed to load expenses");
      })
      .finally(() => {
        setFetching(false);
      });
  };

  useEffect(() => {`
);

// Remove the frontend grouping
code = code.replace(
  /\/\/ Group by Category.*?const totalExpense = categoryRows\.reduce\(\(sum, row\) => sum \+ row\.amount, 0\);/s,
  ``
);

// Update table headers
code = code.replace(
  /<th className="px-5 py-3 text-\[10px\] font-black text-slate-400 uppercase tracking-widest">Category Type<\/th>/g,
  `<th className="px-5 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Transaction Count</th>
   <th className="px-5 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">% of Total</th>`
);

// Update table body
code = code.replace(
  /<td className="px-5 py-3\.5 text-\[13px\] font-semibold text-slate-500 dark:text-slate-400">\s*\{r\.type\}\s*<\/td>/g,
  `<td className="px-5 py-3.5 text-[13px] font-semibold text-slate-500 dark:text-slate-400">
                      {r.count}
                    </td>
                    <td className="px-5 py-3.5 text-[13px] font-semibold text-slate-500 dark:text-slate-400">
                      {totalExpense > 0 ? ((r.totalAmount / totalExpense) * 100).toFixed(1) : 0}%
                    </td>`
);

// Replace amount rendering
code = code.replace(
  /\{fmt\(r\.amount\)\}/g,
  `{fmt(r.totalAmount)}`
);

// Fix colSpan
code = code.replace(/colSpan=\{3\}/g, `colSpan={4}`);

fs.writeFileSync('../erp-frontend/src/app/reports/components/ExpenseCategoryReport.tsx', code);
console.log('done');
