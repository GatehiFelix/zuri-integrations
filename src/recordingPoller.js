import crypto from "node:crypto";
import { pool, withTx } from "./db.js";
import { enqueue } from "./queue.js";
import { locate } from "./lib/recordings.js";

const CDR_TABLE = process.env.CDR_TABLE || "asteriskcdrdb.cdr";
const FAST = Number(process.env.REC_FAST_LOOKBACK_SEC || 900);
const DEEP = Number(process.env.REC_DEEP_LOOKBACK_SEC || 10800);
const POLL_MS = Number(process.env.REC_POLL_MS || 5000);
const DEEP_MS = Number(process.env.REC_DEEP_MS || 120000);
const STABLE_SEC = Number(process.env.REC_STABLE_SEC || 10);
const GIVEUP_SEC = Number(process.env.REC_GIVEUP_SEC || 600);
const MAX_ROWS = 2000, MAX_STAT = 50;
const BASE_URL = (process.env.PUBLIC_API_BASE || "").replace(/\/$/, "");
const TYPE = "call.recording.ready";
const CP = "recording_cdr", CP_FLOOR = "recording_cdr_floor";
const TRAIL = /-(\d{9,11}\.\d+)\.wav$/i;

const log = (...a) => console.log(new Date().toISOString(), "[rec]", ...a);
const warn = (...a) => console.error(new Date().toISOString(), "[rec]", ...a);
const iso = (s) => new Date(Number(s) * 1000).toISOString();
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const trunkOf = (ch) => /^[^/]+\/(.+?)-[0-9a-f]+$/i.exec(String(ch || ""))?.[1]?.toLowerCase() ?? null;
const warned = new Set();

async function loadEndpoints() {
  const [rows] = await pool.query("SELECT product_id, event_types, cdr_trunks FROM integration_endpoints WHERE enabled = 1");
  const byProduct = new Map(), byTrunk = new Map();
  for (const e of rows) {
    if (!e.event_types.split(",").map((s) => s.trim()).includes(TYPE)) continue;
    byProduct.set(String(e.product_id), e);
    for (const t of String(e.cdr_trunks || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) byTrunk.set(t, e);
  }
  return { byProduct, byTrunk };
}

async function getCp(name) {
  const [r] = await pool.query("SELECT last_id FROM integration_checkpoint WHERE name = ?", [name]);
  return r.length ? Number(r[0].last_id) : null;
}
async function ensureCheckpoints() {
  let last = await getCp(CP), floor = await getCp(CP_FLOOR);
  if (last === null || floor === null) {
    const [[m]] = await pool.query(`SELECT COALESCE(UNIX_TIMESTAMP(MAX(calldate)), UNIX_TIMESTAMP()) AS m FROM ${CDR_TABLE}`);
    const start = Number(m.m);
    await pool.query("INSERT IGNORE INTO integration_checkpoint (name, last_id) VALUES (?, ?), (?, ?)", [CP, start, CP_FLOOR, start]);
    last = await getCp(CP); floor = await getCp(CP_FLOOR);
    log(`first run: checkpoint ${iso(start)}, no backfill`);
  }
  return { last, floor };
}

async function pass(lookbackSec) {
  const { byProduct, byTrunk } = await loadEndpoints();
  if (!byProduct.size) return { scanned: 0, queued: 0 };
  const { last, floor } = await ensureCheckpoints();
  const from = Math.max(last - lookbackSec, floor);

  const [rows] = await pool.query(
    `SELECT recordingfile AS name, UNIX_TIMESTAMP(MIN(calldate)) AS start_ts, UNIX_TIMESTAMP(MAX(calldate)) AS last_ts,
            MAX(billsec) AS billsec, GROUP_CONCAT(DISTINCT dstchannel) AS chans
       FROM ${CDR_TABLE}
      WHERE calldate >= FROM_UNIXTIME(?) AND recordingfile <> ''
      GROUP BY recordingfile
      ORDER BY start_ts ASC
      LIMIT ${MAX_ROWS}`, [from]);
  if (!rows.length) return { scanned: 0, queued: 0 };

  const cands = [];
  for (const r of rows) {
    const name = String(r.name);
    let ep = null, direction = null;
    const q = /^q-(\d+)-/.exec(name);
    if (q) { ep = byProduct.get(q[1]); direction = "inbound"; }
    else for (const ch of String(r.chans || "").split(",")) {
      const e = byTrunk.get(trunkOf(ch));
      if (e) { ep = e; direction = "outbound"; break; }
    }
    if (ep) cands.push({ r, name, ep, direction, fileKey: sha1(name) });
  }

  const have = new Set();
  const byPid = new Map();
  for (const c of cands) (byPid.get(c.ep.product_id) ?? byPid.set(c.ep.product_id, []).get(c.ep.product_id)).push(c.fileKey);
  for (const [pid, keys] of byPid) {
    const [ex] = await pool.query("SELECT file_key FROM integration_recordings WHERE product_id = ? AND file_key IN (?)", [pid, keys]);
    for (const e of ex) have.add(`${pid}\u0000${e.file_key}`);
  }
  const todo = cands.filter((c) => !have.has(`${c.ep.product_id}\u0000${c.fileKey}`)).slice(0, MAX_STAT);

  const now = Math.floor(Date.now() / 1000);
  const ready = [];
  for (const c of todo) {                      // an SFTP error throws: checkpoint stays, next pass retries
    const loc = await locate(c.name, Number(c.r.start_ts));
    if (!loc) {
      if (now - Number(c.r.start_ts) > GIVEUP_SEC && !warned.has(c.fileKey)) { warned.add(c.fileKey); warn(`file not found: ${c.name}`); }
      continue;
    }
    if (loc.size <= 44 || now - loc.mtime < STABLE_SEC) continue;   // empty or still being written
    ready.push({ ...c, loc });
  }

  const maxTs = Math.max(...rows.map((r) => Number(r.last_ts)));
  const ids = await withTx(async (conn) => {
    const out = [];
    for (const x of ready) {
      const id = crypto.randomBytes(12).toString("hex");
      const callId = TRAIL.exec(x.name)?.[1] ?? x.name;
      const [ins] = await conn.query(
        `INSERT IGNORE INTO integration_recordings (id, product_id, call_id, file_key, rel_path, direction, size_bytes, duration_sec)
         VALUES (?,?,?,?,?,?,?,?)`,
        [id, x.ep.product_id, callId, x.fileKey, x.loc.rel, x.direction, x.loc.size, Number(x.r.billsec) || 0]);
      if (ins.affectedRows !== 1) continue;
      const eventId = `recording:${x.fileKey.slice(0, 16)}`;
      const payload = JSON.stringify({
        event_id: eventId, type: TYPE, tenant: String(x.ep.product_id), call_id: callId, direction: x.direction,
        started_at: iso(x.r.start_ts),
        recording: { id, formats: ["mp3", "wav"], default_format: "mp3", size_bytes: x.loc.size,
                     duration_sec: Number(x.r.billsec) || 0, url: `${BASE_URL}/v1/recordings/${id}` },
      });
      const [res] = await conn.query(
        `INSERT IGNORE INTO integration_outbox (product_id, event_id, event_type, payload, next_attempt_at) VALUES (?,?,?,?,NOW())`,
        [x.ep.product_id, eventId, TYPE, payload]);
      if (res.affectedRows === 1) out.push(res.insertId);
    }
    await conn.query("UPDATE integration_checkpoint SET last_id = GREATEST(last_id, ?) WHERE name = ?", [maxTs, CP]);
    return out;
  });

  try { await enqueue(ids); } catch (e) { warn(`enqueue failed for ${ids.length} events (sweeper will retry): ${e.message}`); }
  return { scanned: rows.length, queued: ids.length };
}

export function startRecordingPoller() {
  let chain = Promise.resolve();
  const run = (sec, label) => () => {
    chain = chain.then(async () => {
      const r = await pass(sec);
      if (r.queued) log(`${label}: scanned=${r.scanned} queued=${r.queued}`);
    }).catch((e) => warn(`${label} pass failed:`, e.message));
  };
  log(`starting fast=${FAST}s/${POLL_MS}ms deep=${DEEP}s/${DEEP_MS}ms`);
  setInterval(run(FAST, "fast"), POLL_MS);
  setInterval(run(DEEP, "deep"), DEEP_MS);
  run(FAST, "fast")();
}