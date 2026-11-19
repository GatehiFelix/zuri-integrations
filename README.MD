# zuri-integrations

Separate Node process that sends ZuriDesk call events to client endpoints (outbox + BullMQ + signed webhooks).
Outbound contacts pull API is the next phase.

```
queue_log -> poller -> integration_outbox (MySQL, source of truth) -> BullMQ job "ob-<id>" -> worker -> client endpoint
                                   ^                                                            |
                                   +--------- sweeper re-enqueues orphans <---------------------+ updates sent/dead
```

MySQL holds the facts (what happened, attempts, errors, dedupe). Redis/BullMQ only does the scheduling:
concurrency, retry delays, graceful drain. A job just means "go look at outbox row N", so losing Redis
loses no events: the sweeper re-enqueues any pending row whose job is missing.

## Setup

1. Admin runs `sql/schema.sql` (creates schema `zuri_integrations`, 4 tables). Uncomment the CREATE USER / GRANT lines:
   SELECT on `zuridev.queue_log` only, full rights on `zuri_integrations`.
2. `cp .env.example .env` and fill in DB creds and `REDIS_URL`. `npm install`.
   Use its own Redis logical DB (`redis://host:6379/1`) or at least keep `QUEUE_PREFIX=zuri-int` so it never
   shares keys with the CRM's queues. The Redis server must run `maxmemory-policy noeviction` (BullMQ requirement).
3. Onboard a tenant (product_id = `queue_log.queue_id`):
   `npm run add-endpoint -- --product 4000 --url https://client.example/hooks/zuri`
   Prints the signing secret once. Send it to the client over a secure channel.
4. `npm start` (run under pm2/systemd; it drains on SIGTERM).

## Local dev without a PBX

```
mysql < sql/dev-queue-log.sql
# .env: QUEUE_LOG_TABLE=zuri_integrations.queue_log_dev  ALLOW_HTTP=true
npm run add-endpoint -- --product 4000 --url http://127.0.0.1:4000
MOCK_SECRET=<secret from above> FAIL_RATE=0.3 npm run mock     # terminal 1
npm start                                                       # terminal 2
npm run seed                                                    # terminal 3, simulates a call
```
Expect one `OK` line for the call (the doubled ENTERQUEUE collapses), a `FAIL` then `OK` on retry with
`FAIL_RATE`, and a second event with `msisdn: null` for the anonymous caller.

## Event (v1)

`POST <endpoint>` with `Content-Type: application/json`

```json
{
  "event_id": "inbound:4000:1694256887:254722636638",
  "type": "call.inbound",
  "direction": "inbound",
  "tenant": "4000",
  "msisdn": "+254722636638",
  "msisdn_raw": "254722636638",
  "started_at": "2026-11-18T10:00:00.000Z"
}
```

Headers: `X-Zuri-Event-Id`, `X-Zuri-Timestamp` (unix seconds), `X-Zuri-Signature` = `sha256=` +
HMAC-SHA256(secret, `"<timestamp>.<raw body>"`). Any 2xx = delivered. Anything else is retried
(10s, 20s, 40s ... capped at 1h, 15 attempts, then `dead`). Delivery is at-least-once: clients dedupe on `event_id`.
New fields (`duration`, `recording_url`) will be added later; clients must ignore unknown fields.

Client-side verification (Node):

```js
const crypto = require('crypto');
function verify(secret, ts, rawBody, header) {
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const exp = 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  return exp.length === header.length && crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(header));
}
```

## Operating it

- Stuck or failing events: `SELECT id, product_id, attempts, last_error FROM integration_outbox WHERE status <> 'sent';`
- Per-attempt history: `integration_delivery_log` (prune it periodically, nothing does yet).
- Re-send a dead event: `UPDATE integration_outbox SET status='pending', attempts=0, next_attempt_at=NOW() WHERE id=?;`
- Poller restarts are safe: checkpoint is in the DB, 200-row overlap, unique `(product_id, event_id)`.
- Redis down: the poller logs "enqueue failed" and keeps writing the outbox; the sweeper (every 30s, rows overdue by
  2 min) enqueues them once Redis is back. Redis wiped: same, nothing lost.
- Retries are BullMQ's (10s, 20s, 40s ... capped at 1h). The attempt count and the `dead` decision live in the outbox,
  so they survive a Redis wipe. Failed/completed jobs are removed from Redis on purpose; history is `integration_outbox` + `integration_delivery_log`.
- Disabled or missing endpoint: events stay `pending` and are re-checked every ~7 min without using up attempts.
- First run starts at the current end of `queue_log` (no history sent). `POLL_BACKFILL=true` overrides.

## Not verified yet

- `TIME_SOURCE`: defaults to `ingest`. In the pasted sample, `trx_id`, `event_time` and `created` disagree.
  Run the test-call query, then set `trx_id` / `event_time` / `created` accordingly.
  `QUEUE_LOG_TZ_OFFSET` only matters for the last two.
- `npm test` covers the helpers, delivery logic (fake DB + local HTTP server) and real BullMQ/Redis round trips
  (retry, dead, duplicate enqueue, sweeper). Redis tests auto-skip without Redis (`TEST_REDIS_URL=redis://host:port` to point elsewhere).
  The poller's and worker's SQL has NOT run against a real MySQL/MariaDB yet: do the dev run above before pointing it at `zuridev`.
- Answered-only vs every arrival: this emits every `ENTERQUEUE` (answered and abandoned).