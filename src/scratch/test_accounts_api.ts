import axios from 'axios';

async function main() {
  const baseURL = 'http://localhost:5000';
  console.log('--- TESTING ACCOUNTS API ---');

  // 1. Test franchise admin login & fetch
  try {
    console.log('\nLogging in as franchise admin (franchise@erp.com)...');
    const loginRes = await axios.post(`${baseURL}/api/auth/login`, {
      identifier: 'franchise@erp.com',
      password: 'admin123'
    });
    const token = loginRes.data.accessToken;
    console.log('Successfully logged in! Fetching accounts...');

    const accountsRes = await axios.get(`${baseURL}/api/accounts`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    console.log(`Returned accounts count: ${accountsRes.data.length}`);
    accountsRes.data.forEach((acc: any) => {
      console.log(`- ${acc.name} (${acc.type}) | Franchise: ${acc.franchiseId}`);
    });
  } catch (err: any) {
    console.error('Error testing franchise admin:', err.response?.data || err.message);
  }

  // 2. Test super admin login & fetch
  try {
    console.log('\nLogging in as super admin (admin@kiddosfood.com)...');
    const loginRes = await axios.post(`${baseURL}/api/auth/login`, {
      identifier: 'admin@kiddosfood.com',
      password: 'admin123'
    });
    const token = loginRes.data.accessToken;
    console.log('Successfully logged in! Fetching accounts...');

    const accountsRes = await axios.get(`${baseURL}/api/accounts`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    console.log(`Returned accounts count: ${accountsRes.data.length}`);
    accountsRes.data.forEach((acc: any) => {
      console.log(`- ${acc.name} (${acc.type}) | Franchise: ${acc.franchiseId}`);
    });
  } catch (err: any) {
    console.error('Error testing super admin:', err.response?.data || err.message);
  }
}

main();
