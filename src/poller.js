import { pool, withTx } from "./db.js";
import { config } from "./config.js";
import { buildInboundEvent } from "./lib/events.js";
import { enqueue } from "./queue.js";

const CP = "inbound_enterqueue";

async function readCheckpoint() {
  const [rows] = await pool.query(
    "SELECT last_id FROM integration_checkpoint WHERE name = ?",
    [CP],
  );
  return rows.length ? Number(rows[0].last_id) : null;
}

// First run: start at the current end of queue_log so we don't blast history at the client
// (set POLL_BACKFILL=true to start from 0 instead).
async function ensureCheckpoint() {
  const existing = await readCheckpoint();
  if (existing !== null) return existing;
  const [[m]] = await pool.query(
    `SELECT COALESCE(MAX(id), 0) AS m FROM ${config.queueLogTable}`,
  );
  const start = config.pollBackfill ? 0 : Number(m.m);
  await pool.query(
    "INSERT IGNORE INTO integration_checkpoint (name, last_id) VALUES (?, ?)",
    [CP, start],
  );
  return (await readCheckpoint()) ?? start;
}

// One pass: read queue_log rows after the checkpoint (re-reading the last POLL_OVERLAP ids to
// survive out-of-order commits), turn ENTERQUEUE rows of onboarded tenants into outbox rows,
// and advance the checkpoint in the same transaction as the outbox writes.
export async function pollOnce() {
  const last = await ensureCheckpoint();

  const [endpoints] = await pool.query(
    "SELECT product_id, default_country_code, event_types FROM integration_endpoints WHERE enabled = 1",
  );
  const byQueue = new Map(
    endpoints
      .filter((e) =>
        e.event_types
          .split(",")
          .map((s) => s.trim())
          .includes("call.inbound"),
      )
      .map((e) => [String(e.product_id), e]),
  );

  let cursor = Math.max(last - config.pollOverlap, 0);
  let queued = 0;
  let scanned = 0;

  for (;;) {
    const [rows] = await pool.query(
      `SELECT id, trx_id, event_time, queue_id, event_name, msisdn, created
         FROM ${config.queueLogTable}
        WHERE id > ?
        ORDER BY id ASC
        LIMIT ?`,
      [cursor, config.pollBatch],
    );
    if (!rows.length) break;
    scanned += rows.length;

    const events = [];
    for (const r of rows) {
      const ep = byQueue.get(String(r.queue_id).trim());
      if (!ep) continue;
      const ev = buildInboundEvent(r, ep, config);
      if (ev) events.push({ productId: ep.product_id, ...ev });
    }

    cursor = rows[rows.length - 1].id;

    const insertedIds = await withTx(async (c) => {
      const ids = [];
      for (const ev of events) {
        const [res] = await c.query(
          `INSERT IGNORE INTO integration_outbox (product_id, event_id, event_type, payload)
           VALUES (?, ?, ?, ?)`,
          [ev.productId, ev.eventId, ev.eventType, ev.payload],
        );
        if (res.affectedRows === 1) ids.push(res.insertId);
      }
      await c.query(
        "UPDATE integration_checkpoint SET last_id = GREATEST(last_id, ?) WHERE name = ?",
        [cursor, CP],
      );
      return ids;
    });
    queued += insertedIds.length;

    // Only after the commit, so a job can never point at a row that doesn't exist. If Redis is down the
    // rows stay pending in the outbox and the sweeper enqueues them later.
    try {
      await enqueue(insertedIds);
    } catch (e) {
      console.error(
        `[poller] enqueue failed for ${insertedIds.length} events (sweeper will retry): ${e.message}`,
      );
    }

    if (rows.length < config.pollBatch) break;
  }

  return { scanned, queued };
}
