import AsteriskManager from "asterisk-manager";
import { pool, withTx } from "../db.js";
import { enqueue } from "../queue.js";

const TYPES = ["agent.queue.joined", "agent.queue.left", "agent.paused", "agent.unpaused"];
const key = (q, l) => `${q}\u0000${l}`;
// location looks like "Local/3602@from-queue/n" -> agent id "3602"
const agentId = (loc) => loc.match(/\d+/)?.[0] ?? loc;

// AGENT_AMI_* wins, otherwise fall back to the CRM's AST_AMI_* names
const E = (k) => process.env[`AGENT_AMI_${k}`] ?? process.env[`AST_AMI_${k}`];
const DRY = process.env.AGENT_DRY_RUN === "1";
const DEBUG = process.env.AGENT_DEBUG === "1"; // logs every raw Queue* AMI event of enabled tenants

const log = (...a) => console.log(new Date().toISOString(), "[agent]", ...a);
const warn = (...a) => console.error(new Date().toISOString(), "[agent]", ...a);

let endpoints = new Map(); // product_id -> { types:Set, exposeName }
const cache = new Map();   // key -> { inQueue, paused }
let bootstrap = new Set(); // products with zero state rows at boot: first pass seeds silently
let firstPass = true, connected = false, inFlight = false, inFlightSince = 0;
let seen = new Set(), seenQueues = new Set();

// proof-of-life counters, printed by the heartbeat
const stats = {
  amiEvents: 0,          // Queue* events from enabled tenants
  ignored: 0,            // Queue* events from tenants that are not enabled
  polls: 0,              // completed QueueStatus cycles
  lastPollAt: null,
  lastAmiEventAt: null,
  emitted: {},           // type -> count
  lastEmitted: null,
};

let chain = Promise.resolve();
const serial = (fn) => (chain = chain.then(fn).catch((e) => warn("ERROR", e.message)));

async function refreshEndpoints() {
  const [rows] = await pool.query(
    "SELECT product_id, event_types, expose_agent_name FROM integration_endpoints WHERE enabled = 1");
  const m = new Map();
  for (const r of rows) {
    const types = new Set(r.event_types.split(",").map((s) => s.trim()).filter((t) => TYPES.includes(t)));
    if (types.size) m.set(String(r.product_id), { types, exposeName: !!r.expose_agent_name });
  }
  endpoints = m;
}

async function loadCache() {
  const [rows] = await pool.query("SELECT product_id, location, in_queue, paused FROM integration_agent_state");
  const have = new Set();
  for (const r of rows) {
    cache.set(key(r.product_id, r.location), { inQueue: !!r.in_queue, paused: !!r.paused });
    have.add(String(r.product_id));
  }
  bootstrap = new Set([...endpoints.keys()].filter((p) => !have.has(p)));
}

function noteEmitted(type, queue, location, seq, extra) {
  stats.emitted[type] = (stats.emitted[type] || 0) + 1;
  stats.lastEmitted = new Date().toISOString();
  log(DRY ? "DRY-EVENT" : "EVENT", type, `tenant=${queue}`, `agent=${agentId(location)}`, `seq=${seq}`, extra || "");
}

async function apply(queue, location, obs) {
  const ep = endpoints.get(queue);
  if (!ep) return;
  const k = key(queue, location);
  const prev = cache.get(k);
  if (!prev && !obs.inQueue) return;
  if (prev && prev.inQueue === obs.inQueue && (!obs.inQueue || prev.paused === obs.paused)) return;

  const wasIn = prev?.inQueue ?? false;
  const wasPaused = prev?.paused ?? false;
  let type = null;
  if (obs.inQueue && !wasIn) type = "agent.queue.joined";
  else if (!obs.inQueue && wasIn) type = "agent.queue.left";
  else if (obs.inQueue && obs.paused !== wasPaused) type = obs.paused ? "agent.paused" : "agent.unpaused";
  const silent = firstPass && bootstrap.has(queue);

  if (silent) log("seed", `tenant=${queue}`, `agent=${agentId(location)}`, `inQueue=${obs.inQueue}`, `paused=${!!obs.paused}`);

  // DRY RUN: no DB writes, no outbox, no enqueue. Cache still advances so each change logs once.
  if (DRY) {
    if (type && !silent && ep.types.has(type))
      noteEmitted(type, queue, location, "-", `reason=${obs.reason ?? "null"} name=${obs.name ?? "null"}`);
    cache.set(k, { inQueue: obs.inQueue, paused: !!obs.paused });
    return;
  }

  const now = new Date();
  const ids = await withTx(async (c) => {
    const [[row]] = await c.query(
      "SELECT seq FROM integration_agent_state WHERE product_id = ? AND location = ? FOR UPDATE",
      [queue, location]);
    const seq = Number(row?.seq ?? 0) + (type && !silent ? 1 : 0);
    await c.query(
      `INSERT INTO integration_agent_state
         (product_id, location, member_name, in_queue, paused, pause_reason, seq, changed_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE member_name=VALUES(member_name), in_queue=VALUES(in_queue),
         paused=VALUES(paused), pause_reason=VALUES(pause_reason), seq=VALUES(seq), changed_at=VALUES(changed_at)`,
      [queue, location, obs.name || null, obs.inQueue ? 1 : 0, obs.paused ? 1 : 0, obs.reason || null, seq, now]);
    if (!type || silent || !ep.types.has(type)) return [];
    const eventId = `agent:${queue}:${location}:${seq}`;
    const payload = {
      event_id: eventId, type, tenant: queue,
      agent: { id: agentId(location), ...(ep.exposeName && obs.name ? { name: obs.name } : {}) },
      paused: !!obs.paused, reason: obs.reason || null,
      occurred_at: now.toISOString(), seq,
    };
    const [res] = await c.query(
      "INSERT IGNORE INTO integration_outbox (product_id, event_id, event_type, payload, next_attempt_at) VALUES (?,?,?,?,NOW())",,
      [queue, eventId, type, JSON.stringify(payload)]);
    if (res.affectedRows === 1) noteEmitted(type, queue, location, seq, `outbox_id=${res.insertId}`);
    else log("DUPLICATE (already in outbox, skipped)", eventId);
    return res.affectedRows === 1 ? [res.insertId] : [];
  });
  cache.set(k, { inQueue: obs.inQueue, paused: !!obs.paused });
  try { await enqueue(ids); } catch (e) { warn("enqueue failed (sweeper retries):", e.message); }
}

const loc = (e) => String(e.interface || e.location || "").trim();
const name = (e) => e.membername || e.name || null;
const reason = (e) => e.reason || e.pausedreason || null;
const paused = (e) => e.paused === "1";

function onEvent(e) {
  const q = e.queue != null ? String(e.queue).trim() : null;

  if (e.event && e.event.startsWith("Queue") && q) {
    if (endpoints.has(q)) {
      stats.amiEvents++;
      stats.lastAmiEventAt = new Date().toISOString();
      if (DEBUG && e.event !== "QueueEntry" && e.event !== "QueueCallerJoin" && e.event !== "QueueCallerLeave")
        log("amiraw", e.event, `queue=${q}`, `iface=${loc(e)}`, `paused=${e.paused ?? "-"}`, `reason=${reason(e) ?? "-"}`, `status=${e.status ?? "-"}`);
    } else {
      stats.ignored++;
    }
  }

  switch (e.event) {
    case "QueueParams": seenQueues.add(q); break;
    case "QueueMember": // QueueStatus replay
      seen.add(key(q, loc(e)));
      serial(() => apply(q, loc(e), { inQueue: true, paused: paused(e), reason: reason(e), name: name(e) }));
      break;
    case "QueueMemberAdded":
    case "QueueMemberStatus":
    case "QueueMemberPause":
      serial(() => apply(q, loc(e), { inQueue: true, paused: paused(e), reason: reason(e), name: name(e) }));
      break;
    case "QueueMemberRemoved":
      serial(() => apply(q, loc(e), { inQueue: false, paused: false, name: name(e) }));
      break;
    case "QueueStatusComplete":
      serial(async () => {
        for (const [k, v] of cache) {
          const [q2, l] = k.split("\u0000");
          if (v.inQueue && seenQueues.has(q2) && !seen.has(k)) await apply(q2, l, { inQueue: false, paused: false });
        }
        if (firstPass) {
          const counts = {};
          for (const [k, v] of cache) if (v.inQueue) { const t = k.split("\u0000")[0]; counts[t] = (counts[t] || 0) + 1; }
          log("first QueueStatus complete. members per tenant:", JSON.stringify(counts), bootstrap.size ? `(seeded silently: ${[...bootstrap].join(",")})` : "");
        }
        seen = new Set(); seenQueues = new Set(); firstPass = false; inFlight = false;
        stats.polls++; stats.lastPollAt = new Date().toISOString();
      });
      break;
  }
}

function heartbeat() {
  const per = {};
  for (const [k, v] of cache) if (v.inQueue) { const t = k.split("\u0000")[0]; per[t] = (per[t] || 0) + 1; }
  log("HEARTBEAT",
    `ami=${connected ? "up" : "DOWN"}`,
    `polls=${stats.polls} lastPoll=${stats.lastPollAt ?? "never"}`,
    `amiEvents=${stats.amiEvents} ignoredOtherTenants=${stats.ignored} lastAmiEvent=${stats.lastAmiEventAt ?? "never"}`,
    `members=${JSON.stringify(per)}`,
    `emitted=${JSON.stringify(stats.emitted)} lastEmitted=${stats.lastEmitted ?? "never"}`);
}

export async function startAgentWatcher() {
  await refreshEndpoints();
  await loadCache();
  log(`starting mode=${DRY ? "DRY-RUN (no DB writes, nothing sent)" : "LIVE"} debug=${DEBUG}`,
    `ami=${E("HOST")}:${E("PORT")} user=${E("USERNAME")}`);
  for (const [p, ep] of endpoints) log("tenant enabled", p, [...ep.types].join(","), `exposeName=${ep.exposeName}`);
  if (!endpoints.size) warn("no tenants have agent.* event types enabled; watcher will do nothing");

  const ami = new AsteriskManager(E("PORT"), E("HOST"), E("USERNAME"), E("PASSWORD"), true);
  ami.keepConnected();
  ami.on("connect", () => { connected = true; log("AMI connected"); });
  ami.on("close", () => { connected = false; inFlight = false; warn("AMI connection closed (will reconnect)"); });
  ami.on("error", (e) => warn("AMI error:", e.message));
  ami.on("managerevent", (e) => setImmediate(() => onEvent(e)));

  setInterval(() => refreshEndpoints().catch((e) => warn("endpoint refresh failed:", e.message)), 60_000);
  setInterval(heartbeat, 60_000);
  setInterval(() => {
    if (!connected) return;
    if (inFlight && Date.now() - inFlightSince > 15_000) { warn("QueueStatus got no Complete within 15s, retrying"); inFlight = false; }
    if (inFlight) return;
    inFlight = true; inFlightSince = Date.now();
    ami.action({ action: "QueueStatus" }, (err) => { if (err) { inFlight = false; warn("QueueStatus failed:", err.message || err); } });
  }, 5000);
}