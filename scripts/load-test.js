const { performance } = require('perf_hooks');
const http = require('http');
const axios = require('axios');

const FEE_URL = process.env.FEE_URL || 'http://localhost:4001';
const BANK_URL = process.env.BANK_URL || 'http://localhost:4002';
const TOTAL = Number(process.env.TOTAL || 200);
const CONCURRENCY = Number(process.env.CONCURRENCY || 10);
const AMOUNT = Number(process.env.AMOUNT || 1000);
const agent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY, maxFreeSockets: CONCURRENCY, timeout: 5000 });
const client = axios.create({ httpAgent: agent, timeout: 4500, validateStatus: () => true });

async function getStats() {
  try { return (await axios.get(`${BANK_URL}/stats`, { timeout: 1000 })).data; }
  catch (e) { return { error: e.message }; }
}
async function main() {
  console.log('Bank stats before:', await getStats());
  const started = performance.now();
  let next = 0, success = 0, failed = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= TOTAL) return;
      try {
        const r = await client.post(`${FEE_URL}/students/1/payments`, { amount: AMOUNT });
        if (r.status === 201 && r.data.status === 'PAID') success++;
        else { failed++; console.error(`Payment ${index + 1}: HTTP ${r.status}`, r.data); }
      } catch (e) { failed++; console.error(`Payment ${index + 1}: ${e.message}`); }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsed = performance.now() - started;
  console.log(JSON.stringify({ total: TOTAL, concurrency: CONCURRENCY, amount: AMOUNT, success, failed, elapsedMs: Math.round(elapsed), requestsPerSecond: Number((TOTAL / (elapsed / 1000)).toFixed(2)) }, null, 2));
  console.log('Bank stats after:', await getStats());
  agent.destroy();
}
main().catch(e => { console.error(e); process.exitCode = 1; });
