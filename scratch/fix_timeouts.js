const fs = require('fs');
const path = require('path');

function processDir(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      processDir(fullPath);
    } else if (fullPath.endsWith('.ts')) {
      let content = fs.readFileSync(fullPath, 'utf8');
      if (content.includes('prisma.$transaction(async')) {
        // Regex to replace `});` that belongs to `$transaction`
        // We'll just replace `prisma.$transaction(async (tx) => {` and so on.
        // Actually, let's just add the timeout directly to the files manually or using a simpler regex.
        let modified = false;
        const lines = content.split('\n');
        let depth = 0;
        let inTransaction = false;
        
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes('prisma.$transaction(async')) {
            inTransaction = true;
            depth = 1; // Assuming it opens a brace `{` on the same line or we just count braces.
          }
        }
      }
    }
  }
}
// This is getting complicated. Let's just fix the files we know.
