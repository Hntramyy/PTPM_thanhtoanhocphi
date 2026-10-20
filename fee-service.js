const express = require('express');
const http = require('http');
const axios = require('axios');
const { randomUUID } = require('crypto');

const app = express();
app.use(express.json());
const PORT = Number(process.env.FEE_PORT || 4001);
const BANK_URL = (process.env.BANK_URL || 'http://localhost:4002').replace(/\/$/, '');
const BANK_TIMEOUT_MS = Math.max(100, Number(process.env.BANK_TIMEOUT_MS || 4000));
const MAX_RETRIES = Math.max(0, Number(process.env.BANK_RETRIES ?? 2));

// Keep-alive pools reuse TCP connections; stale sockets are retried safely using the same idempotency key.
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 20, maxFreeSockets: 10, timeout: 5000 });
const bank = axios.create({ baseURL: BANK_URL, timeout: BANK_TIMEOUT_MS, httpAgent, validateStatus: () => true });
const fees = new Map([['1', 50_000_000], ['2', 0], ['3', 3_200_000]]);
const payments = new Map();
let nextPayment = 1;

function paymentError(res, code, error, paymentId, status) {
  return res.status(code).json({ error, paymentId, status });
}
function isTimeout(err) {
  return err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT';
}
function isConnectionError(err) {
  return ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'EPIPE', 'EAI_AGAIN'].includes(err.code);
}

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/students/:id/fees', (req, res) => {
  const id = req.params.id;
  if (!fees.has(id)) return res.status(404).json({ error: 'Student not found' });
  return res.status(200).json({ studentId: id, outstanding: fees.get(id), currency: 'VND' });
});

app.post('/students/:id/payments', async (req, res) => {
  const studentId = req.params.id;
  const amount = req.body && req.body.amount;
  if (!fees.has(studentId)) return res.status(404).json({ error: 'Student not found', status: 'FAILED' });
  if (!Number.isSafeInteger(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be a positive integer in VND', status: 'FAILED' });
  if (amount > fees.get(studentId)) return res.status(400).json({ error: 'Amount exceeds outstanding fee', status: 'FAILED' });

  const paymentId = `P${nextPayment++}`;
  const reference = paymentId;
  const idempotencyKey = paymentId;
  const payment = { paymentId, studentId, amount, status: 'PENDING', createdAt: new Date().toISOString() };
  payments.set(paymentId, payment);

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await bank.post('/charges', { reference, amount }, {
        headers: { 'Idempotency-Key': idempotencyKey }
      });
      if (response.status === 201) {
        // A confirmed response (including idempotent replay) means the bank charged this payment.
        payment.status = 'PAID';
        payment.chargeId = response.data.chargeId;
        fees.set(studentId, fees.get(studentId) - amount);
        return res.status(201).json({ paymentId, status: 'PAID', amount, outstanding: fees.get(studentId), chargeId: response.data.chargeId });
      }
      if (response.status === 402 || response.status === 400) {
        payment.status = 'FAILED';
        return paymentError(res, response.status, response.data.error || 'Bank rejected payment', paymentId, 'FAILED');
      }
      if (response.status >= 500) {
        lastError = new Error(`Bank returned HTTP ${response.status}`);
        // Retry only transient 5xx, with the same idempotency key.
        if (attempt < MAX_RETRIES) continue;
        payment.status = 'FAILED';
        return paymentError(res, 502, 'Bank temporarily unavailable', paymentId, 'FAILED');
      }
      payment.status = 'FAILED';
      return paymentError(res, 502, 'Unexpected bank response', paymentId, 'FAILED');
    } catch (err) {
      lastError = err;
      if (isTimeout(err)) {
        payment.status = 'PENDING';
        return paymentError(res, 504, 'Timed out waiting for bank; charge outcome is unknown', paymentId, 'PENDING');
      }
      // A reset can happen after the bank charged but before its response arrived.
      // Retry only connection-level errors, always reusing the same key.
      if (isConnectionError(err)) {
        if (attempt < MAX_RETRIES) continue;
        if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH' || err.code === 'EAI_AGAIN') {
          payment.status = 'FAILED';
          return paymentError(res, 503, 'Cannot connect to bank; no charge was made', paymentId, 'FAILED');
        }
        payment.status = 'PENDING';
        return paymentError(res, 504, 'Connection lost while awaiting bank response; charge outcome is unknown', paymentId, 'PENDING');
      }
      payment.status = 'FAILED';
      return paymentError(res, 502, 'Unexpected error calling bank', paymentId, 'FAILED');
    }
  }
  payment.status = 'FAILED';
  return paymentError(res, 502, lastError ? lastError.message : 'Bank unavailable', paymentId, 'FAILED');
});

app.get('/payments/:id', (req, res) => {
  const payment = payments.get(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  return res.json(payment);
});
app.get('/payments', (_req, res) => res.json([...payments.values()]));

const server = http.createServer(app);
server.listen(PORT, () => console.log(`[FEE] listening on http://localhost:${PORT}; BANK_URL=${BANK_URL}; timeout=${BANK_TIMEOUT_MS}ms; retries=${MAX_RETRIES}`));
