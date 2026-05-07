import { AccountService } from '../src/modules/finance/account.service';

async function test() {
  console.log('Testing AccountService.getAccounts()...');
  try {
    const accounts = await AccountService.getAccounts();
    console.log('SUCCESS:', accounts);
  } catch (err: any) {
    console.error('CRITICAL ERROR:', err.message);
    console.error(err);
  }
}

test();
