import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';

export async function withRollback(work: (tx: any) => Promise<void>) {
  const original = prisma.$transaction.bind(prisma);
  const rollback = new Error('ROLLBACK_TEST_FIXTURES');
  try {
    await original(async tx => {
      const restore: Array<() => void> = [];
      for (const model of Prisma.dmmf.datamodel.models) {
        const name = model.name.charAt(0).toLowerCase() + model.name.slice(1);
        const live = (prisma as any)[name], delegate = (tx as any)[name];
        for (const method of ['findUnique','findUniqueOrThrow','findFirst','findFirstOrThrow','findMany','count','aggregate','groupBy','create','createMany','update','updateMany','upsert','delete','deleteMany']) {
          if (typeof live?.[method] !== 'function') continue;
          const before = live[method]; live[method] = delegate[method].bind(delegate); restore.push(() => { live[method] = before; });
        }
      }
      (prisma as any).$transaction = (fn: any) => fn(tx);
      try { await work(tx); } finally { restore.reverse().forEach(fn => fn()); (prisma as any).$transaction = original; }
      throw rollback;
    }, { timeout: 120000 });
  } catch (e) { if (e !== rollback) throw e; }
}
