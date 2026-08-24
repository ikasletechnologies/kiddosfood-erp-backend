import prisma from './src/lib/prisma';
prisma.franchise.findMany().then((f: any) => { console.log(JSON.stringify(f, null, 2)); process.exit(0); }).catch((e: any) => { console.error(e); process.exit(1); });
