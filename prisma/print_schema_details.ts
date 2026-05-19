import fs from 'fs';
import path from 'path';

const schemaPath = path.resolve(__dirname, 'schema.prisma');
const schema = fs.readFileSync(schemaPath, 'utf8');

const getBlock = (modelName: string) => {
  const regex = new RegExp(`model ${modelName}\\s+\\{[\\s\\S]*?\\}`, 'i');
  const match = schema.match(regex);
  return match ? match[0] : `Model ${modelName} not found`;
};

console.log('--- ORDERITEM ---');
console.log(getBlock('OrderItem'));

console.log('--- PRODUCT ---');
console.log(getBlock('Product'));

console.log('--- INVENTORYITEM ---');
console.log(getBlock('InventoryItem'));
process.exit(0);
