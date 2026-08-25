import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: "postgresql://food_admin:food_password@localhost:5432/food_erp_db"
    }
  }
});

async function main() {
  const customerCount = await prisma.customer.count();
  console.log("LOCAL DB Customer count:", customerCount);
  
  if (customerCount > 0) {
    const customers = await prisma.customer.findMany({ take: 5 });
    console.log("LOCAL DB Customers:", customers.map(c => c.name));
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
