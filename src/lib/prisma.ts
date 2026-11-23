import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const prismaClientSingleton = () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  // Franchise.aadhaarEncrypted is omitted from every query result by default so
  // the ciphertext never leaks through an `include: { franchise: true }`.
  // User.passwordHash is likewise omitted everywhere (it was returned by
  // /api/users, /api/franchise/:id/users and any `include: { user: true }`);
  // AuthService.login opts back in explicitly.
  const client = new PrismaClient({ adapter, omit: { franchise: { aadhaarEncrypted: true }, user: { passwordHash: true } } });

  // Globally increase interactive transaction timeouts to prevent expiration errors
  const originalTransaction = client.$transaction.bind(client);
  (client as any).$transaction = async (...args: any[]) => {
    if (args.length === 1 && typeof args[0] === 'function') {
      return (originalTransaction as any)(args[0], { maxWait: 15000, timeout: 30000 });
    } else if (args.length === 2 && typeof args[0] === 'function') {
      return (originalTransaction as any)(args[0], { maxWait: 15000, timeout: 30000, ...args[1] });
    }
    return (originalTransaction as any)(...args);
  };

  return client;
};

declare global {
  var prisma: undefined | ReturnType<typeof prismaClientSingleton>;
}

const prisma = globalThis.prisma ?? prismaClientSingleton();

export default prisma;

if (process.env.NODE_ENV !== 'production') globalThis.prisma = prisma;
