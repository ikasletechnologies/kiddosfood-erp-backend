import { execSync } from 'child_process';

try {
  console.log('🚀 Starting Prisma Client Generation...');
  const output = execSync('npx prisma generate', { encoding: 'utf-8' });
  console.log('✅ Prisma Client successfully regenerated!');
  console.log(output);
} catch (error: any) {
  console.error('❌ Failed to generate Prisma Client:');
  console.error(error.message);
  if (error.stdout) console.log(error.stdout);
  if (error.stderr) console.error(error.stderr);
}
