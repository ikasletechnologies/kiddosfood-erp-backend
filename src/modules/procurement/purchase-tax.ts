export function purchaseGstRate(value: unknown, label = 'Purchase line'): number {
  if (value === null || value === undefined || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) throw new Error(`${label}: an explicit GST rate is required (select 0% for tax-free goods).`);
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new Error(`${label}: GST must be a finite rate between 0% and 100%.`);
  return rate;
}

export function purchaseLineTax(poItems: any[], materialId: string | null, label = 'Purchase line') {
  const matches = poItems.filter(p => p.inventoryItemId === materialId);
  const rates = [...new Set(matches.map(p => purchaseGstRate(p.gstRate, label)))];
  if (rates.length !== 1) throw new Error(`${label}: original PO tax snapshot is missing or ambiguous; review the source purchase lines.`);
  return rates[0];
}

export function validateTaxTotals(manual: any, calculated: { cgst: number; sgst: number; igst: number }) {
  if (!manual) return;
  for (const field of ['cgst','sgst','igst'] as const) {
    if (!Number.isFinite(Number(manual[field])) || Math.abs(Number(manual[field])-calculated[field]) > 0.011) throw new Error('Purchase tax amounts must match the saved line GST rates. Use an audited tax correction for changes.');
  }
}
