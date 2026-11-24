// src/cdrPoller.js
// Outbound call events from asteriskcdrdb.cdr -> integration_outbox (event type call.outbound.completed).
//
// - One query for all tenants; trunk (dstchannel) -> endpoint via integration_endpoints.cdr_trunks.
// - cdr rows land at HANGUP but carry the START time in calldate, and only calldate is indexed, so we scan
//   `calldate >= checkpoint - lookback`: a fast pass (short lookback, every few seconds) and a deep pass
//   (long lookback, every couple of minutes) to catch long calls. Outbox event_id dedupes the overlap.
// - All times are epoch seconds computed by the DB (UNIX_TIMESTAMP / FROM_UNIXTIME in the same session tz), so
//   there is no timezone config here and no mixing of the PBX clock with the service clock.
import { pool, withTx } from "./db.js";
import { enqueue } from "./queue.js";

const CDR_TABLE = process.env.CDR_TABLE || "asteriskcdrdb.cdr";
const FAST_LOOKBACK = Number(process.env.CDR_FAST_LOOKBACK_SEC || 900); // 15 min
const DEEP_LOOKBACK = Number(process.env.CDR_DEEP_LOOKBACK_SEC || 10800); // 3 h (calls longer than this are dropped)
const POLL_MS = Number(process.env.CDR_POLL_MS || 5000);
const DEEP_MS = Number(process.env.CDR_DEEP_MS || 120000);
const MAX_ROWS = 5000;
const TYPE = "call.outbound.completed";
const CP = "outbound_cdr";
const CP_FLOOR = "outbound_cdr_floor";

const log = (...a) => console.log(new Date().toISOString(), "[cdr]", ...a);
const warn = (...a) => console.error(new Date().toISOString(), "[cdr]", ...a);

// Minimal E.164. If the repo already has its own toE164 (src/lib), swap this for it.
function toE164(raw, cc) {
  let d = String(raw ?? "").replace(/[^\d+]/g, "");
  if (!d) return null;
  const c = String(cc ?? "").replace(/\D/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0") && c) d = c + d.slice(1);
  else if (!(c && d.startsWith(c) && d.length >= 10)) return null;
  return /^\d{8,15}$/.test(d) ? `+${d}` : null;
}

const trunkOf = (dstchannel) => /^[^/]+\/(.+?)-[0-9a-f]+$/i.exec(String(dstchannel || ""))?.[1]?.toLowerCase() ?? null;
const dialedOf = (lastdata, dst) => /^[^/]+\/[^/]+\/([^,]+)/.exec(String(lastdata || ""))?.[1] ?? String(dst || "");
const iso = (s) => new Date(Number(s) * 1000).toISOString();

async function loadEndpoints() {
  const [rows] = await pool.query(
    `SELECT product_id, default_country_code, event_types, expose_agent_name, cdr_trunks
       FROM integration_endpoints
      WHERE enabled = 1 AND cdr_trunks IS NOT NULL AND cdr_trunks <> ''`);
  const byTrunk = new Map();
  for (const e of rows) {
    if (!e.event_types.split(",").map((s) => s.trim()).includes(TYPE)) continue;
    for (const t of e.cdr_trunks.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
      if (byTrunk.has(t)) warn(`trunk "${t}" configured on more than one endpoint; keeping product ${byTrunk.get(t).product_id}`);
      else byTrunk.set(t, e);
    }
  }
  return byTrunk;
}

async function getCp(name) {
  const [r] = await pool.query("SELECT last_id FROM integration_checkpoint WHERE name = ?", [name]);
  return r.length ? Number(r[0].last_id) : null;
}

// First run: start at the current end of cdr (no history to the client).
async function ensureCheckpoints() {
  let last = await getCp(CP);
  let floor = await getCp(CP_FLOOR);
  if (last === null || floor === null) {
    const [[m]] = await pool.query(`SELECT COALESCE(UNIX_TIMESTAMP(MAX(calldate)), UNIX_TIMESTAMP()) AS m FROM ${CDR_TABLE}`);
    const start = Number(m.m);
    await pool.query("INSERT IGNORE INTO integration_checkpoint (name, last_id) VALUES (?, ?), (?, ?)", [CP, start, CP_FLOOR, start]);
    last = await getCp(CP);
    floor = await getCp(CP_FLOOR);
    log(`first run: checkpoint set to ${iso(start)}, no backfill`);
  }
  return { last, floor };
}

function buildEvent(r, ep) {
  const callId = String(r.uniqueid);
  const eventId = `outbound:${callId}`;
  const raw = dialedOf(r.lastdata, r.dst);
  const started = Number(r.cd_ts);
  const dur = Number(r.duration), bill = Number(r.billsec);
  const answered = String(r.disposition).toUpperCase() === "ANSWERED";
  const name = r.cnam && String(r.cnam).trim();
  const payload = {
    event_id: eventId, type: TYPE, direction: "outbound",
    tenant: String(ep.product_id), call_id: callId,
    msisdn: toE164(raw, ep.default_country_code), msisdn_raw: raw,
    started_at: iso(started),
    answered_at: answered && bill > 0 ? iso(started + Math.max(dur - bill, 0)) : null,
    ended_at: iso(r.ended_ts),
    duration: dur, billsec: bill, disposition: r.disposition, answered,
    agent: { id: String(r.cnum || ""), ...(ep.expose_agent_name && name ? { name } : {}) },
  };
  return { productId: ep.product_id, eventId, payload: JSON.stringify(payload) };
}

async function pass(lookbackSec) {
  const byTrunk = await loadEndpoints();
  if (!byTrunk.size) return { scanned: 0, queued: 0 };
  const { last, floor } = await ensureCheckpoints();
  const from = Math.max(last - lookbackSec, floor);

  const [rows] = await pool.query(
    `SELECT uniqueid, UNIX_TIMESTAMP(calldate) AS cd_ts, UNIX_TIMESTAMP(actioned) AS ended_ts,
            duration, billsec, disposition, cnum, cnam, dst, dstchannel, lastdata
       FROM ${CDR_TABLE}
      WHERE calldate >= FROM_UNIXTIME(?)
        AND dcontext = 'from-internal' AND lastapp = 'Dial'
      ORDER BY calldate ASC
      LIMIT ${MAX_ROWS}`, [from]);
  if (!rows.length) return { scanned: 0, queued: 0 };
  if (rows.length >= MAX_ROWS) warn(`hit MAX_ROWS=${MAX_ROWS}; shorten lookback or raise the cap`);

  const events = [];
  for (const r of rows) {
    const ep = byTrunk.get(trunkOf(r.dstchannel));
    if (ep) events.push(buildEvent(r, ep));
  }
  const maxTs = Math.max(...rows.map((r) => Number(r.cd_ts)));

  // pre-check existing ids so the overlap doesn't burn outbox auto-increment ids every pass
  const have = new Set();
  const byProduct = new Map();
  for (const ev of events) (byProduct.get(ev.productId) ?? byProduct.set(ev.productId, []).get(ev.productId)).push(ev.eventId);
  for (const [pid, ids] of byProduct) {
    const [ex] = await pool.query("SELECT event_id FROM integration_outbox WHERE product_id = ? AND event_id IN (?)", [pid, ids]);
    for (const e of ex) have.add(`${pid}\u0000${e.event_id}`);
  }
  const fresh = events.filter((ev) => !have.has(`${ev.productId}\u0000${ev.eventId}`));

  const insertedIds = await withTx(async (c) => {
    const ids = [];
    for (const ev of fresh) {
      const [res] = await c.query(
        `INSERT IGNORE INTO integration_outbox (product_id, event_id, event_type, payload, next_attempt_at)
         VALUES (?, ?, ?, ?, NOW())`, [ev.productId, ev.eventId, TYPE, ev.payload]);
      if (res.affectedRows === 1) ids.push(res.insertId);
    }
    await c.query("UPDATE integration_checkpoint SET last_id = GREATEST(last_id, ?) WHERE name = ?", [maxTs, CP]);
    return ids;
  });

  try { await enqueue(insertedIds); }
  catch (e) { warn(`enqueue failed for ${insertedIds.length} events (sweeper will retry): ${e.message}`); }
  return { scanned: rows.length, queued: insertedIds.length };
}

export function startCdrPoller() {
  let chain = Promise.resolve();
  const run = (sec, label) => () => {
    chain = chain
      .then(async () => {
        const r = await pass(sec);
        if (r.queued) log(`${label}: scanned=${r.scanned} queued=${r.queued}`);
      })
      .catch((e) => warn(`${label} pass failed:`, e.message));
  };
  log(`starting table=${CDR_TABLE} fast=${FAST_LOOKBACK}s/${POLL_MS}ms deep=${DEEP_LOOKBACK}s/${DEEP_MS}ms`);
  setInterval(run(FAST_LOOKBACK, "fast"), POLL_MS);
  setInterval(run(DEEP_LOOKBACK, "deep"), DEEP_MS);
  run(FAST_LOOKBACK, "fast")();
}