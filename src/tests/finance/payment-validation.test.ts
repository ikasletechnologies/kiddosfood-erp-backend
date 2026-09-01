import prisma from '../../lib/prisma';
import { FinanceService } from '../../modules/finance/finance.service';
import { AccountService } from '../../modules/finance/account.service';
import { PaymentValidationError } from '../../utils/errors';

async function runPaymentValidationTests() {
  console.log('=== RUNNING PAYMENT-IN VALIDATION TESTS ===\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${testName} ${detail ? `(${detail})` : ''}`);
      failed++;
    }
  }

  // Setup test sandbox environment
  console.log('--- Creating test accounts ---');
  
  // Clean up old test accounts if present
  await prisma.account.deleteMany({
    where: { name: { startsWith: 'TEST_VAL_' } }
  });

  const cashAcc = await AccountService.createAccount({
    name: 'TEST_VAL_CASH_1',
    type: 'CASH',
    balance: 5000
  });

  const bankAcc = await AccountService.createAccount({
    name: 'TEST_VAL_BANK_1',
    type: 'BANK',
    balance: 10000
  });

  const upiAcc = await AccountService.createAccount({
    name: 'TEST_VAL_UPI_1',
    type: 'UPI',
    balance: 2000
  });

  const inactiveBankAcc = await prisma.account.create({
    data: {
      name: 'TEST_VAL_BANK_INACTIVE',
      type: 'BANK',
      balance: 100,
      status: 'INACTIVE',
      accountCode: `ACC-TEST-${Date.now()}`
    }
  });

  // TEST 1: Cash payment with active Cash account -> SUCCESS
  try {
    const p1 = await FinanceService.createPayment({
      amount: 500,
      flow: 'IN',
      method: 'CASH',
      sourceAccount: cashAcc.id,
      createdBy: 'TestRunner'
    });
    assert(p1 && p1.accountId === cashAcc.id, 'Cash payment with active cash account succeeds');
  } catch (err: any) {
    assert(false, 'Cash payment with active cash account succeeds', err.message);
  }

  // TEST 2: Bank payment missing sourceAccount -> 400 BANK_ACCOUNT_REQUIRED
  try {
    await FinanceService.createPayment({
      amount: 1000,
      flow: 'IN',
      method: 'BANK_TRANSFER',
      createdBy: 'TestRunner'
    });
    assert(false, 'Bank payment missing account should fail');
  } catch (err: any) {
    assert(
      err instanceof PaymentValidationError && err.code === 'BANK_ACCOUNT_REQUIRED',
      'Bank payment missing account throws BANK_ACCOUNT_REQUIRED',
      `Got code: ${err.code}, msg: ${err.message}`
    );
  }

  // TEST 3: Bank payment with selected active Bank account -> SUCCESS
  try {
    const p3 = await FinanceService.createPayment({
      amount: 1000,
      flow: 'IN',
      method: 'BANK_TRANSFER',
      sourceAccount: bankAcc.id,
      createdBy: 'TestRunner'
    });
    assert(p3 && p3.accountId === bankAcc.id, 'Bank payment with active bank account succeeds');
  } catch (err: any) {
    assert(false, 'Bank payment with active bank account succeeds', err.message);
  }

  // TEST 4: Bank payment with inactive account -> 400 ACCOUNT_INACTIVE
  try {
    await FinanceService.createPayment({
      amount: 500,
      flow: 'IN',
      method: 'BANK_TRANSFER',
      sourceAccount: inactiveBankAcc.id,
      createdBy: 'TestRunner'
    });
    assert(false, 'Bank payment with inactive account should fail');
  } catch (err: any) {
    assert(
      err instanceof PaymentValidationError && err.code === 'ACCOUNT_INACTIVE',
      'Bank payment with inactive account throws ACCOUNT_INACTIVE',
      `Got code: ${err.code}, msg: ${err.message}`
    );
  }

  // TEST 5: Bank payment with Cash account (type mismatch) -> 400 INVALID_ACCOUNT_FOR_PAYMENT_MODE
  try {
    await FinanceService.createPayment({
      amount: 500,
      flow: 'IN',
      method: 'BANK_TRANSFER',
      sourceAccount: cashAcc.id,
      createdBy: 'TestRunner'
    });
    assert(false, 'Bank payment with Cash account should fail');
  } catch (err: any) {
    assert(
      err instanceof PaymentValidationError && err.code === 'INVALID_ACCOUNT_FOR_PAYMENT_MODE',
      'Bank payment with Cash account throws INVALID_ACCOUNT_FOR_PAYMENT_MODE',
      `Got code: ${err.code}`
    );
  }

  // TEST 6: UPI payment with valid UPI account -> SUCCESS
  try {
    const p6 = await FinanceService.createPayment({
      amount: 300,
      flow: 'IN',
      method: 'UPI',
      sourceAccount: upiAcc.id,
      createdBy: 'TestRunner'
    });
    assert(p6 && p6.accountId === upiAcc.id, 'UPI payment with valid UPI account succeeds');
  } catch (err: any) {
    assert(false, 'UPI payment with valid UPI account succeeds', err.message);
  }

  // TEST 7: UPI payment missing sourceAccount -> 400 UPI_ACCOUNT_REQUIRED
  try {
    await FinanceService.createPayment({
      amount: 300,
      flow: 'IN',
      method: 'UPI',
      createdBy: 'TestRunner'
    });
    assert(false, 'UPI payment missing account should fail');
  } catch (err: any) {
    assert(
      err instanceof PaymentValidationError && err.code === 'UPI_ACCOUNT_REQUIRED',
      'UPI payment missing account throws UPI_ACCOUNT_REQUIRED',
      `Got code: ${err.code}`
    );
  }

  // TEST 8: Cheque payment missing cheque details -> 400 CHEQUE_DETAILS_REQUIRED
  try {
    await FinanceService.createPayment({
      amount: 1500,
      flow: 'IN',
      method: 'CHEQUE',
      sourceAccount: bankAcc.id,
      createdBy: 'TestRunner'
    });
    assert(false, 'Cheque payment missing details should fail');
  } catch (err: any) {
    assert(
      err instanceof PaymentValidationError && err.code === 'CHEQUE_DETAILS_REQUIRED',
      'Cheque payment missing details throws CHEQUE_DETAILS_REQUIRED',
      `Got code: ${err.code}`
    );
  }

  // TEST 9: Cheque payment with valid details -> SUCCESS
  try {
    const p9 = await FinanceService.createPayment({
      amount: 1500,
      flow: 'IN',
      method: 'CHEQUE',
      sourceAccount: bankAcc.id,
      chequeNumber: 'CHQ-990011',
      chequeDate: new Date().toISOString(),
      bankName: 'HDFC Bank',
      createdBy: 'TestRunner'
    });
    assert(p9 && p9.accountId === bankAcc.id, 'Cheque payment with valid details succeeds');
  } catch (err: any) {
    assert(false, 'Cheque payment with valid details succeeds', err.message);
  }

  // Cleanup test accounts
  console.log('\n--- Cleaning up test records ---');
  await prisma.payment.deleteMany({
    where: { accountId: { in: [cashAcc.id, bankAcc.id, upiAcc.id, inactiveBankAcc.id] } }
  });
  await prisma.account.deleteMany({
    where: { id: { in: [cashAcc.id, bankAcc.id, upiAcc.id, inactiveBankAcc.id] } }
  });

  console.log(`\n=== TEST SUMMARY: ${passed} Passed, ${failed} Failed ===`);
  await prisma.$disconnect();

  if (failed > 0) {
    process.exit(1);
  }
}

runPaymentValidationTests().catch(err => {
  console.error(err);
  process.exit(1);
});
