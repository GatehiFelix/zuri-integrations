import { Worker, UnrecoverableError } from "bullmq";
import { pool } from "./db.js";
import { config } from "./config.js";
import { sign } from "./lib/sign.js";
import { nextDelaySec } from "./lib/backoff.js";
import { QUEUE_NAME, createWorkerConnection, enqueue } from "./queue.js";

const trunc = (s, n) => String(s ?? "").slice(0, n);
const backoffOpts = () => ({
  base: config.backoffBaseSec,
  cap: config.backoffCapSec,
  jitter: 0,
});

// Delivers one outbox row. The outbox row is the truth: the BullMQ job only says "go look at row N".
//   'sent'    2xx received, row marked sent
//   'skipped' row is gone or no longer pending (already sent / dead): nothing to do
//   'parked'  endpoint missing or disabled: row stays pending, retried later by the sweeper
// A failed attempt is recorded, then this throws so BullMQ retries it with backoff; at MAX_ATTEMPTS
// the row is marked 'dead' and an UnrecoverableError stops BullMQ from retrying.
export async function deliverOutbox(outboxId, db = pool) {
  const [rows] = await db.query(
    `SELECT o.id, o.event_id, o.payload, o.attempts, o.status, e.url, e.secret, e.enabled
       FROM integration_outbox o
       LEFT JOIN integration_endpoints e ON e.product_id = o.product_id
      WHERE o.id = ?`,
    [outboxId],
  );
  const row = rows[0];
  if (!row || row.status !== "pending") return "skipped";

  if (!row.url || !row.enabled) {
    await db.query(
      `UPDATE integration_outbox
          SET next_attempt_at = DATE_ADD(NOW(), INTERVAL 300 SECOND), last_error = ?
        WHERE id = ?`,
      ["endpoint missing or disabled", row.id],
    );
    return "parked";
  }

  const attempt = row.attempts + 1;
  const started = Date.now();
  let status = null;
  let err = null;

  try {
    if (!config.allowHttp && !/^https:\/\//i.test(row.url))
      throw new Error("endpoint url is not https");
    const ts = Math.floor(Date.now() / 1000);
    const res = await fetch(row.url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(config.httpTimeoutMs),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "ZuriDesk-Integrations/1",
        "X-Zuri-Event-Id": row.event_id,
        "X-Zuri-Timestamp": String(ts),
        "X-Zuri-Signature": sign(row.secret, ts, row.payload),
      },
      body: row.payload,
    });
    status = res.status;
    await res.body?.cancel?.();
    if (status < 200 || status >= 300) err = `HTTP ${status}`;
  } catch (e) {
    err = e.name === "TimeoutError" ? "timeout" : e.cause?.code || e.message;
  }

  await db.query(
    "INSERT INTO integration_delivery_log (outbox_id, attempt, status_code, error, duration_ms) VALUES (?, ?, ?, ?, ?)",
    [
      row.id,
      attempt,
      status,
      err ? trunc(err, 255) : null,
      Date.now() - started,
    ],
  );

  if (!err) {
    await db.query(
      `UPDATE integration_outbox SET status = 'sent', attempts = ?, sent_at = NOW(), last_error = NULL WHERE id = ?`,
      [attempt, row.id],
    );
    return "sent";
  }

  if (attempt >= config.maxAttempts) {
    await db.query(
      `UPDATE integration_outbox SET status = 'dead', attempts = ?, last_error = ? WHERE id = ?`,
      [attempt, trunc(err, 500), row.id],
    );
    throw new UnrecoverableError(`gave up after ${attempt} attempts: ${err}`);
  }

  // next_attempt_at mirrors the BullMQ delay; the sweeper only uses it to spot rows whose job vanished.
  await db.query(
    `UPDATE integration_outbox
        SET attempts = ?, last_error = ?, next_attempt_at = DATE_ADD(NOW(), INTERVAL ? SECOND)
      WHERE id = ?`,
    [attempt, trunc(err, 500), nextDelaySec(attempt, backoffOpts()), row.id],
  );
  throw new Error(err);
}

export function startDeliveryWorker(db = pool) {
  const worker = new Worker(
    QUEUE_NAME,
    (job) => deliverOutbox(job.data.outboxId, db),
    {
      connection: createWorkerConnection(),
      prefix: config.queuePrefix,
      concurrency: config.workerConcurrency,
      settings: {
        backoffStrategy: (attemptsMade) =>
          nextDelaySec(attemptsMade, backoffOpts()) * 1000,
      },
    },
  );
  worker.on("error", (e) => console.error("[worker] bullmq error:", e.message));
  worker.on("failed", (job, e) => {
    console.warn(
      `[worker] outbox ${job?.data?.outboxId} attempt ${job?.attemptsMade}: ${e.message}`,
    );
  });
  return worker;
}

// Safety net for the two ways the outbox and Redis can disagree: the process died (or Redis was down)
// between the outbox commit and the enqueue, or Redis lost its data. Re-adding a job that already
// exists is a no-op, so this is safe to run on a timer.
export async function sweepOrphans(db = pool) {
  const [rows] = await db.query(
    `SELECT id FROM integration_outbox
      WHERE status = 'pending' AND next_attempt_at < DATE_SUB(NOW(), INTERVAL ? SECOND)
      ORDER BY id ASC
      LIMIT 500`,
    [config.sweepOverdueSec],
  );
  const ids = rows.map((r) => r.id);
  await enqueue(ids);
  return { enqueued: ids.length };
}
