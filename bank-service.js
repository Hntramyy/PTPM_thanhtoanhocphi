const express = require('express');
const http = require('http');
const crypto = require('crypto');

const app = express();
app.use(express.json());
const PORT = Number(process.env.BANK_PORT || 4002);
const DELAY_MS = Math.max(0, Number(process.env.DELAY_MS || 0));
const FAIL_RATE = clampRate(process.env.FAIL_RATE);
const DROP_RATE = clampRate(process.env.DROP_RATE);
const LIMIT = 20_000_000;
const transactions = new Map(); // idempotency key -> original result
let connections = 0;
let requests = 0;
let charges = 0;
let duplicates = 0; // repeated keys never deduct twice, so this must remain zero

function clampRate(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

app.post('/charges', async (req, res) => {
  requests++;
  const { reference, amount } = req.body || {};
  const key = req.get('Idempotency-Key');
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount) || !reference || !key) {
    return res.status(400).json({ error: 'reference, Idempotency-Key and positive integer amount are required' });
  }

  // Return the original result for a retry, without charging again.
  if (transactions.has(key)) {
    const previous = transactions.get(key);
    return res.status(201).json({ ...previous, idempotentReplay: true });
  }

  if (amount > LIMIT) return res.status(402).json({ error: 'Amount exceeds bank limit', limit: LIMIT });
  if (DELAY_MS) await wait(DELAY_MS);
  // Simulated transient failure happens before charging.
  if (Math.random() < FAIL_RATE) return res.status(500).json({ error: 'Temporary bank failure' });

  const result = { chargeId: `CH-${crypto.randomUUID()}`, reference, amount };
  transactions.set(key, result);
  charges++;

  // Simulate charge completed but response lost. Destroy only this response socket.
  if (Math.random() < DROP_RATE) {
    req.socket.destroy();
    return;
  }
  return res.status(201).json(result);
});

app.get('/stats', (_req, res) => res.json({ connections, requests, charges, duplicates }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const server = http.createServer(app);
server.keepAliveTimeout = 5000;
server.headersTimeout = 6000;
server.on('connection', socket => {
  connections++;
  console.log(`[BANK] TCP connection #${connections} from ${socket.remoteAddress}:${socket.remotePort}`);
});
server.listen(PORT, () => console.log(`[BANK] listening on http://localhost:${PORT}; DELAY_MS=${DELAY_MS}, FAIL_RATE=${FAIL_RATE}, DROP_RATE=${DROP_RATE}`));
