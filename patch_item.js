const fs = require('fs');
let code = fs.readFileSync('../erp-frontend/src/app/reports/components/ExpenseItemReport.tsx', 'utf8');

// Replace fetch endpoint and type
code = code.replace(
  /interface Expense \{.*?\}/s,
  `interface ExpenseItemRow {
  id: string;
  date: string;
  category: string;
  expenseItem: string;
  quantity: number;
  unitRate: number;
  amount: number;
}`
);

code = code.replace(
  /const \[expenses, setExpenses\] = useState<Expense\[\]>\(\[\]\);/g,
  `const [expenses, setExpenses] = useState<ExpenseItemRow[]>([]);`
);

code = code.replace(
  /accountingApi\n\s*\.getExpenses\(\{/s,
  `accountingApi\n      .getExpenseItem({`
);

code = code.replace(
  /\.then\(\(res: any\) => \{\n\s*setExpenses\(res\.data\?\.expenses \|\| \[\]\);\n\s*\}\)/s,
  `.then((res: any) => {\n        setExpenses(res.data || []);\n      })`
);

// Replace sorting and aggregation logic
code = code.replace(
  /\/\/ Aggregate by category representing items.*?const toggleSort =/s,
  `// Sorting logic
  let aggregatedRows = [...searchedExpenses];
  aggregatedRows.sort((a, b) => {
    let valA: any = a[sortField];
    let valB: any = b[sortField];
    if (typeof valA === "string") {
      return sortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
    }
    return sortAsc ? valA - valB : valB - valA;
  });

  const toggleSort =`
);

code = code.replace(
  /const \[sortField, setSortField\] = useState<"itemName" \| "unitPrice" \| "quantity" \| "amount">\("itemName"\);/g,
  `const [sortField, setSortField] = useState<"date" | "category" | "expenseItem" | "quantity" | "unitRate" | "amount">("date");`
);

code = code.replace(
  /const toggleSort = \(field: "itemName" \| "unitPrice" \| "quantity" \| "amount"\) => \{/g,
  `const toggleSort = (field: "date" | "category" | "expenseItem" | "quantity" | "unitRate" | "amount") => {`
);

code = code.replace(
  /const matchesCategory = \(e\.category \|\| ""\)\.toLowerCase\(\)\.includes\(searchQuery\.toLowerCase\(\)\);\n\s*const matchesDesc = \(e\.description \|\| ""\)\.toLowerCase\(\)\.includes\(searchQuery\.toLowerCase\(\)\);/s,
  `const matchesCategory = (e.category || "").toLowerCase().includes(searchQuery.toLowerCase());
    const matchesDesc = (e.expenseItem || "").toLowerCase().includes(searchQuery.toLowerCase());`
);

// Update table headers
code = code.replace(
  /<th[^>]*>\s*<div[^>]*>\s*<span>Expense Item<\/span>.*?<\/th>\s*<th[^>]*>\s*<div[^>]*>\s*<span>Unit Price<\/span>.*?<\/th>\s*<th[^>]*>\s*<div[^>]*>\s*<span>Quantity<\/span>.*?<\/th>\s*<th[^>]*>\s*<div[^>]*>\s*<span>Amount<\/span>.*?<\/th>/s,
  `<th
                  onClick={() => toggleSort("date")}
                  className="px-5 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors"
                >
                  <div className="flex items-center gap-1">
                    <span>Date</span>
                    <SortIcon size={10} className="text-slate-400" />
                  </div>
                </th>
                <th
                  onClick={() => toggleSort("category")}
                  className="px-5 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors"
                >
                  <div className="flex items-center gap-1">
                    <span>Category</span>
                    <SortIcon size={10} className="text-slate-400" />
                  </div>
                </th>
                <th
                  onClick={() => toggleSort("expenseItem")}
                  className="px-5 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors"
                >
                  <div className="flex items-center gap-1">
                    <span>Expense Item</span>
                    <SortIcon size={10} className="text-slate-400" />
                  </div>
                </th>
                <th
                  onClick={() => toggleSort("quantity")}
                  className="px-5 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors"
                >
                  <div className="flex items-center gap-1">
                    <span>Quantity</span>
                    <SortIcon size={10} className="text-slate-400" />
                  </div>
                </th>
                <th
                  onClick={() => toggleSort("unitRate")}
                  className="px-5 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors"
                >
                  <div className="flex items-center gap-1">
                    <span>Unit Rate</span>
                    <SortIcon size={10} className="text-slate-400" />
                  </div>
                </th>
                <th
                  onClick={() => toggleSort("amount")}
                  className="px-5 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors text-right"
                >
                  <div className="flex items-center justify-end gap-1">
                    <span>Amount</span>
                    <SortIcon size={10} className="text-slate-400" />
                  </div>
                </th>`
);

// Update table body rendering
code = code.replace(
  /<tr\s*key=\{idx\}\s*className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50\/50 dark:hover:bg-slate-800\/10 transition-colors"\s*>\s*<td.*?<\/td>\s*<td.*?<\/td>\s*<td.*?<\/td>\s*<td.*?<\/td>\s*<\/tr>/s,
  `<tr
                    key={idx}
                    className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/10 transition-colors"
                  >
                    <td className="px-5 py-3.5 text-[13px] font-bold text-slate-800 dark:text-slate-200">
                      {fmtDate(r.date)}
                    </td>
                    <td className="px-5 py-3.5 text-[13px] font-semibold text-slate-500 dark:text-slate-400">
                      {r.category}
                    </td>
                    <td className="px-5 py-3.5 text-[13px] font-semibold text-slate-500 dark:text-slate-400">
                      {r.expenseItem}
                    </td>
                    <td className="px-5 py-3.5 text-[13px] font-semibold text-slate-500 dark:text-slate-400">
                      {r.quantity}
                    </td>
                    <td className="px-5 py-3.5 text-[13px] font-semibold text-slate-500 dark:text-slate-400">
                      {fmt(r.unitRate)}
                    </td>
                    <td className="px-5 py-3.5 text-[13px] font-black text-slate-900 dark:text-white text-right tabular-nums">
                      {fmt(r.amount)}
                    </td>
                  </tr>`
);

code = code.replace(/colSpan=\{4\}/g, `colSpan={6}`);

fs.writeFileSync('../erp-frontend/src/app/reports/components/ExpenseItemReport.tsx', code);
console.log('done');
