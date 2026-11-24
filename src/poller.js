import { pool, withTx } from "./db.js";
import { config } from "./config.js";
import { buildInboundEvent } from "./lib/events.js";
import { buildAnsweredEvent, loadAgentIds } from "./lib/answered.js";
import { enqueue } from "./queue.js";

const CP = "inbound_enterqueue";
const msisdnByCall = new Map();


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
    "SELECT product_id, default_country_code, event_types, expose_agent_name FROM integration_endpoints WHERE enabled = 1",
  );
  const byQueue = new Map(
    endpoints
      .map((e) => ({
        ...e,
        types: new Set(e.event_types.split(",").map((s) => s.trim())),
      }))
      .filter(
        (e) => e.types.has("call.inbound") || e.types.has("call.answered"),
      )
      .map((e) => [String(e.product_id), e]),
  );
  const agentIds = [...byQueue.values()].some((e) =>
    e.types.has("call.answered"),
  )
    ? await loadAgentIds(pool)
    : new Map();
  let cursor = Math.max(last - config.pollOverlap, 0);
  let queued = 0;
  let scanned = 0;

  for (;;) {
    const [rows] = await pool.query(
      `SELECT id, trx_id, event_time, queue_id, event_name,delay_time , msisdn, created
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
      if (r.event_name === "ENTERQUEUE" && r.msisdn) {
  msisdnByCall.set(String(r.event_time), r.msisdn);
  if (msisdnByCall.size > 5000) msisdnByCall.delete(msisdnByCall.keys().next().value);
}
      const ep = byQueue.get(String(r.queue_id).trim());
      if (!ep) continue;
      const ev =
        r.event_name === "ENTERQUEUE" && ep.types.has("call.inbound")
          ? buildInboundEvent(r, ep, config)
          : r.event_name === "CONNECT" && ep.types.has("call.answered")
            ? buildAnsweredEvent(r, ep, config, agentIds, msisdnByCall)
            : null;
      if (ev) events.push({ productId: ep.product_id, ...ev });
      if (ev) events.push({ productId: ep.product_id, ...ev });
    }

    cursor = rows[rows.length - 1].id;

    const insertedIds = await withTx(async (c) => {
      const ids = [];
      for (const ev of events) {
        const [res] = await c.query(
          `INSERT IGNORE INTO integration_outbox (product_id, event_id, event_type, payload, next_attempt_at)
            VALUES (?, ?, ?, ?, NOW())`,
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
