
const http = require('http');
const axios = require('axios');
const { performance } = require('perf_hooks');

const BASE = 'http://localhost:4001';
const client = axios.create({
  httpAgent: new http.Agent({
    keepAlive: true,
    maxSockets: 25
  }),
  timeout: 10000,
  validateStatus: () => true
});

async function main() {
  console.log('Dang tao 20 thanh toan dong thoi...');
  const start = performance.now();

  const payments = Array.from({ length: 20 }, (_, i) =>
    client.post(`${BASE}/students/1/payments`, {
      amount: 1000
    }).then(r => ({
      index: i + 1,
      status: r.status,
      result: r.data.status
    })).catch(e => ({
      index: i + 1,
      error: e.message
    }))
  );

  // Chờ một chút để các request đi vào trạng thái chờ ngân hàng.
  await new Promise(resolve => setTimeout(resolve, 300));

  const getStart = performance.now();
  try {
    const r = await client.get(`${BASE}/students/1/fees`, {
      timeout: 1000
    });
    const getMs = Math.round(performance.now() - getStart);

    console.log('\nGET cong no:');
    console.log('HTTP:', r.status);
    console.log('Thoi gian:', getMs, 'ms');
    console.log('Du lieu:', JSON.stringify(r.data));
  } catch (e) {
    console.log('GET cong no loi:', e.message);
  }

  console.log('\nDang cho ket qua 20 thanh toan...');
  const results = await Promise.all(payments);
  console.log(JSON.stringify({
    total: results.length,
    elapsedMs: Math.round(performance.now() - start),
    results
  }, null, 2));

  client.defaults.httpAgent.destroy();
}

main().catch(console.error);
