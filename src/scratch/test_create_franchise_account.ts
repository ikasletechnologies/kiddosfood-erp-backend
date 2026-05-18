import axios from 'axios';

async function main() {
  const baseURL = 'http://localhost:5000';
  console.log('--- TESTING NEW FRANCHISE ACCOUNT CREATION ---');

  try {
    // 1. Log in as franchise admin
    console.log('Logging in as franchise admin (franchise@erp.com)...');
    const loginRes = await axios.post(`${baseURL}/api/auth/login`, {
      identifier: 'franchise@erp.com',
      password: 'admin123'
    });
    const token = loginRes.data.accessToken;
    console.log('Successfully logged in! Creating a new financial account...');

    // 2. Create a new account
    const createRes = await axios.post(
      `${baseURL}/api/accounts`,
      {
        name: 'Downtown Savings Wallet',
        type: 'UPI',
        balance: 8500
      },
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    console.log('New Account Created Successfully:', {
      id: createRes.data.id,
      name: createRes.data.name,
      type: createRes.data.type,
      balance: createRes.data.balance,
      franchiseId: createRes.data.franchiseId
    });

    // 3. Fetch accounts to verify listing
    console.log('\nFetching all accounts to verify it is listed in isolation...');
    const accountsRes = await axios.get(`${baseURL}/api/accounts`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    console.log(`Returned accounts count: ${accountsRes.data.length}`);
    accountsRes.data.forEach((acc: any) => {
      console.log(`- ${acc.name} (${acc.type}) | Balance: ₹${acc.balance} | Franchise: ${acc.franchiseId}`);
    });

  } catch (err: any) {
    console.error('Error during testing:', err.response?.data || err.message);
  }
}

main();
