import axios from 'axios';

async function main() {
  try {
    // Log in
    const loginRes = await axios.post('http://localhost:5000/api/auth/login', {
      identifier: 'admin@kiddosfood.com',
      password: 'admin123'
    });
    const token = loginRes.data.accessToken;
    console.log('✅ Logged in successfully. Token acquired.');

    // Fetch raw materials with exact params used by the frontend
    const materialsRes = await axios.get('http://localhost:5000/api/raw-materials', {
      params: {
        includeInactive: false,
        franchiseId: 'hq-001'
      },
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    console.log('✅ API Request with params succeeded. Response count:', materialsRes.data.length);
    console.log(JSON.stringify(materialsRes.data, null, 2));

  } catch (error: any) {
    console.error('❌ API Request failed:', error.response?.data || error.message);
  }
  process.exit(0);
}

main();
