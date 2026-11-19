import crypto from 'node:crypto';

// Signature = HMAC-SHA256(secret, `${timestamp}.${rawBody}`), sent as "sha256=<hex>".
export function sign(secret, timestamp, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

// Reference verifier (also what we hand to the client in the docs).
export function verify(secret, timestamp, body, header, { toleranceSec = 300, nowSec } = {}) {
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(Number(timestamp)) || Math.abs(now - Number(timestamp)) > toleranceSec) return false;
  const expected = Buffer.from(sign(secret, timestamp, body));
  const got = Buffer.from(String(header ?? ''));
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}