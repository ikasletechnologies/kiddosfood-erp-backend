import fs from 'fs';

const filePath = 'd:/erpkiddos/erp-frontend/kiddosfood-erp-frontend/src/app/sales/invoices/SalesInvoicesClient.tsx';
let content = fs.readFileSync(filePath, 'utf8');

// Normalize line endings to \n temporarily for reliable matching
const isCrlf = content.includes('\r\n');
content = content.replace(/\r\n/g, '\n');

// 1. Update getPartyDisplayName
const oldPartyDisplay = `export function getPartyDisplayName(order: any, invoice?: any): string {
  if (!order && !invoice) return "Walk-In Customer";
  const o = order || invoice?.order || {};
  
  if (o.customerName && typeof o.customerName === "string" && o.customerName.trim() && o.customerName !== "Unknown") {
    return o.customerName.trim();
  }
  if (invoice?.customerName && typeof invoice.customerName === "string" && invoice.customerName.trim() && invoice.customerName !== "Unknown") {
    return invoice.customerName.trim();
  }
  if (o.dealer?.name && typeof o.dealer.name === "string" && o.dealer.name.trim()) {
    return o.dealer.name.trim();
  }
  if (o.franchise?.name && typeof o.franchise.name === "string" && o.franchise.name.trim()) {
    return o.franchise.name.trim();
  }
  if (o.customer?.name && typeof o.customer.name === "string" && o.customer.name.trim()) {
    return o.customer.name.trim();
  }
  return "Walk-In Customer";
}`;

const newPartyDisplay = `export function getPartyDisplayName(order: any, invoice?: any): string {
  if (!order && !invoice) return "Walk-In Customer";
  const o = order || invoice?.order || {};
  
  if (o.customerName && typeof o.customerName === "string" && o.customerName.trim() && o.customerName !== "Unknown") {
    return o.customerName.trim();
  }
  if (invoice?.customerName && typeof invoice.customerName === "string" && invoice.customerName.trim() && invoice.customerName !== "Unknown") {
    return invoice.customerName.trim();
  }
  if (o.dealer?.name && typeof o.dealer.name === "string" && o.dealer.name.trim()) {
    return o.dealer.name.trim();
  }
  if (o.buyerFranchise?.name && typeof o.buyerFranchise.name === "string" && o.buyerFranchise.name.trim()) {
    return o.buyerFranchise.name.trim();
  }
  if (o.partyType === "FRANCHISE" && o.franchise?.name && typeof o.franchise.name === "string" && o.franchise.name.trim()) {
    return o.franchise.name.trim();
  }
  if (o.customer?.name && typeof o.customer.name === "string" && o.customer.name.trim()) {
    return o.customer.name.trim();
  }
  return "Walk-In Customer";
}`;

if (content.includes(oldPartyDisplay)) {
  content = content.replace(oldPartyDisplay, newPartyDisplay);
  console.log('1. Replaced getPartyDisplayName');
} else {
  console.warn('1. Could not find oldPartyDisplay');
}

// 2. Remove setSelectedFranchiseId in franchise order deep link
const oldFoSetFran = `if (order.franchiseId) {\n            setSelectedFranchiseId(order.franchiseId);\n          }`;
if (content.includes(oldFoSetFran)) {
  content = content.replace(oldFoSetFran, '// Franchise Order deep-link buyer identity set to selectedCustomer');
  console.log('2. Removed setSelectedFranchiseId in FO deep link');
} else {
  console.warn('2. Could not find oldFoSetFran');
}

if (isCrlf) {
  content = content.replace(/\n/g, '\r\n');
}

fs.writeFileSync(filePath, content, 'utf8');
console.log('Done writing SalesInvoicesClient.tsx');
