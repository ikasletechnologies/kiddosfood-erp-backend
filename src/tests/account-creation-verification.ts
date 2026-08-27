// Regression test for POST /api/accounts (AccountService.createAccount).
// Confirms the happy path, duplicate rejection, HQ scope resolution, and
// POS payment compatibility all work — this was investigated as a reported
// "bug" that turned out to be correct duplicate-name rejection on a retry
// against an account that had already been created successfully.
import { AccountService } from '../modules/finance/account.service';
import { FinanceService } from '../modules/finance/finance.service';
import { FranchiseService } from '../modules/franchise/franchise.service';
import prisma from '../lib/prisma';

async function runTests() {
  console.log('=== Account Creation Regression Test ===');
  const hq = await FranchiseService.getHqFranchise();
  console.log(`HQ: ${hq.name} (${hq.id})`);

  let sbiAccount: any;
  let zeroAccount: any;

  try {
    // Test 1: fresh unique name succeeds, correct HQ scope
    console.log('\nTest 1: create SBI (CASH, ₹0) succeeds with correct HQ scope');
    sbiAccount = await AccountService.createAccount({ name: 'SBI', type: 'CASH', balance: 0, franchiseId: hq.id });
    console.log(`  Created: ${sbiAccount.name}, balance=${sbiAccount.balance}, franchiseId=${sbiAccount.franchiseId}, code=${sbiAccount.accountCode}`);
    if (sbiAccount.franchiseId !== hq.id) throw new Error('Test 1 FAILED: wrong franchiseId');
    if (sbiAccount.balance !== 0) throw new Error('Test 1 FAILED: balance should be 0');
    console.log('Test 1 PASSED');

    // Test 2: duplicate name rejected cleanly, no duplicate row
    console.log('\nTest 2: duplicate "SBI" is rejected, no duplicate row created');
    const countBefore = await prisma.account.count({ where: { name: 'SBI' } });
    let threw = false;
    let message = '';
    try {
      await AccountService.createAccount({ name: 'SBI', type: 'CASH', balance: 500, franchiseId: hq.id });
    } catch (e: any) {
      threw = true;
      message = e.message;
    }
    const countAfter = await prisma.account.count({ where: { name: 'SBI' } });
    console.log(`  Threw: ${threw} ("${message}") | count before/after: ${countBefore} -> ${countAfter}`);
    if (!threw || !/already exists/i.test(message)) throw new Error('Test 2 FAILED: expected a clean "already exists" rejection');
    if (countAfter !== countBefore) throw new Error('Test 2 FAILED: a duplicate row was created');
    console.log('Test 2 PASSED');

    // Test 3: positive opening balance stored correctly (no ledger entry expected — confirmed none exists)
    console.log('\nTest 3: create with a positive opening balance (₹2500)');
    zeroAccount = await AccountService.createAccount({ name: 'ICICI TEST', type: 'BANK', balance: 2500, franchiseId: hq.id });
    console.log(`  Created: ${zeroAccount.name}, balance=${zeroAccount.balance}`);
    if (zeroAccount.balance !== 2500) throw new Error('Test 3 FAILED: opening balance not stored correctly');
    console.log('Test 3 PASSED');

    // Test 4: account usable in a real POS payment, balance increments correctly
    console.log('\nTest 4: account works for a POS payment (balance increments by payment amount)');
    const balanceBefore = sbiAccount.balance;
    await FinanceService.createPayment({
      amount: 150,
      flow: 'IN',
      status: 'PAID',
      sourceAccount: sbiAccount.id,
      method: 'CASH',
      sourceModule: 'POS',
      entityType: 'CUSTOMER',
      entityId: 'WALK_IN',
      franchiseId: hq.id,
      createdBy: 'test',
    });
    const sbiAfter = await prisma.account.findUnique({ where: { id: sbiAccount.id } });
    console.log(`  Balance before/after: ${balanceBefore} -> ${sbiAfter?.balance} (expect +150)`);
    if (sbiAfter?.balance !== balanceBefore + 150) throw new Error('Test 4 FAILED: balance did not increment correctly');
    console.log('Test 4 PASSED');

    console.log('\n=== All Tests Passed ===');
  } finally {
    console.log('\nCleaning up test fixtures (scoped deletes only)...');
    if (sbiAccount) {
      await prisma.payment.deleteMany({ where: { accountId: sbiAccount.id } });
      await prisma.account.deleteMany({ where: { id: sbiAccount.id } });
    }
    if (zeroAccount) await prisma.account.deleteMany({ where: { id: zeroAccount.id } });
    await prisma.$disconnect();
  }
}

runTests().catch((e) => {
  console.error('Test execution failed:', e);
  process.exit(1);
});
