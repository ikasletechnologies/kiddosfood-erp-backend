import prisma from '../lib/prisma';
import bcrypt from 'bcryptjs';

async function testLogin() {
  const email = 'franchise@erp.com';
  const password = 'admin123';
  
  const user = await prisma.user.findFirst({
    where: { email }
  });
  
  if (!user) {
    console.log('User not found');
    return;
  }
  
  const isMatch = await bcrypt.compare(password, user.passwordHash);
  console.log(`Login test for ${email}: ${isMatch ? 'SUCCESS' : 'FAILED'}`);
}

testLogin().finally(() => prisma.$disconnect());
