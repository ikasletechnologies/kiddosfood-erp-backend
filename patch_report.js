const fs = require('fs');
let code = fs.readFileSync('../erp-frontend/src/app/reports/components/ExpenseReport.tsx', 'utf8');

// Add summary state
code = code.replace(
  /const \[fetching, setFetching\] = useState\(false\);/,
  `const [fetching, setFetching] = useState(false);
  const [summary, setSummary] = useState({ totalExpenses: 0, totalPaid: 0, totalUnpaid: 0 });`
);

// Update fetch to save summary
code = code.replace(
  /setExpenses\(res\.data\?\.expenses \|\| \[\]\);/,
  `setExpenses(res.data?.expenses || []);
        if (res.data?.summary) setSummary(res.data.summary);`
);

// Update table headers
code = code.replace(
  /<th className="px-5 py-3 text-\[10px\] font-black text-slate-400 uppercase tracking-widest">Payment Mode<\/th>/,
  `<th className="px-5 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Payment Mode</th>
   <th className="px-5 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">Status</th>`
);

// Update table body rows
code = code.replace(
  /<td className="px-5 py-3\.5 text-\[13px\] font-semibold text-slate-600 dark:text-slate-400">\s*\{e\.paymentMode \|\| "CASH"\}\s*<\/td>/,
  `<td className="px-5 py-3.5 text-[13px] font-semibold text-slate-600 dark:text-slate-400">
                      {e.paymentMode || "CASH"}
                    </td>
                    <td className="px-5 py-3.5 text-[13px] font-black text-center">
                      <span className={\`px-2 py-0.5 rounded text-[10px] uppercase tracking-wide \${e.status === 'PAID' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'}\`}>
                        {e.status || 'UNPAID'}
                      </span>
                    </td>`
);

// Update colSpan for empty state
code = code.replace(/colSpan=\{7\}/g, `colSpan={8}`);

// Replace SUMMARY FOOTER
code = code.replace(
  /\{\/\* SUMMARY FOOTER \*\/\}.*?<\/div>\s*<\/div>\s*\)\}/s,
  `{/* SUMMARY FOOTER */}
        {expenses.length > 0 && (
          <div className="bg-slate-50 dark:bg-slate-800/40 border-t border-slate-200 dark:border-slate-700 p-5 flex flex-wrap justify-between items-center text-right font-black gap-4">
            <div className="flex items-center gap-6 text-[13px]">
              <div className="text-slate-500">Paid: <span className="text-green-600">{fmt(summary.totalPaid)}</span></div>
              <div className="text-slate-500">Pending: <span className="text-orange-500">{fmt(summary.totalUnpaid)}</span></div>
            </div>
            <div className="text-slate-800 dark:text-slate-200 text-[14px]">
              Total Expense: <span className="text-red-600 dark:text-red-400 text-[16px]">{fmt(summary.totalExpenses)}</span>
            </div>
          </div>
        )}`
);

fs.writeFileSync('../erp-frontend/src/app/reports/components/ExpenseReport.tsx', code);
console.log('done');
