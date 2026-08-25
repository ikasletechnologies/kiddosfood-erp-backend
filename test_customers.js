const axios = require('axios');

async function test() {
  try {
    // 1. Login to get token
    const loginRes = await axios.post('http://localhost:5000/api/auth/login', {
      identifier: 'superadmin',
      password: 'password123'
    });
    
    const token = loginRes.data.accessToken;
    
    // 2. Fetch customers
    const res = await axios.get('http://localhost:5000/api/customers', {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    console.log(JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
  }
}

test();
