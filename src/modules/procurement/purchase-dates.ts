export const PURCHASE_TIME_ZONE = 'Asia/Kolkata';
export function purchaseBusinessDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: PURCHASE_TIME_ZONE, year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(now);
  const value = (name: string) => parts.find(p=>p.type===name)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
export function purchaseDateValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10)!==value) throw new Error(`${label} is invalid.`);
    return value;
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid.`);
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(value)) throw new Error(`${label} must be a date-only value or include an explicit timezone.`);
  purchaseDateValue(value.slice(0,10), label);
  return purchaseBusinessDate(new Date(value));
}
export function validateDeliveryDate(value: unknown, purchaseDay: string, now = new Date()): Date {
  const day = purchaseDateValue(value,'Expected Delivery');
  if (day < purchaseDay || day < purchaseBusinessDate(now)) throw new Error('Expected Delivery must be today or a future date and cannot be before Purchase Date (Asia/Kolkata).');
  return new Date(`${day}T00:00:00.000+05:30`);
}
export function validatePurchaseDate(value: unknown, expectedDay: string) {
  if (value !== undefined && purchaseDateValue(value,'Purchase Date') !== expectedDay) throw new Error('Purchase Date is set by the server and cannot be changed.');
}
