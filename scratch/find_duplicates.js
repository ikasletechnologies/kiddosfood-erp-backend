
const fs = require('fs');
const content = fs.readFileSync('prisma/schema.prisma', 'utf8');
const lines = content.split('\n');

const models = {};
const enums = {};

lines.forEach((line, index) => {
    const modelMatch = line.match(/^model\s+(\w+)\s+{/);
    if (modelMatch) {
        const name = modelMatch[1];
        if (!models[name]) models[name] = [];
        models[name].push(index + 1);
    }

    const enumMatch = line.match(/^enum\s+(\w+)\s+{/);
    if (enumMatch) {
        const name = enumMatch[1];
        if (!enums[name]) enums[name] = [];
        enums[name].push(index + 1);
    }
});

console.log('--- Duplicate Models ---');
Object.entries(models).forEach(([name, lines]) => {
    if (lines.length > 1) console.log(`${name}: ${lines.join(', ')}`);
});

console.log('--- Duplicate Enums ---');
Object.entries(enums).forEach(([name, lines]) => {
    if (lines.length > 1) console.log(`${name}: ${lines.join(', ')}`);
});
