// src/lib/answered.js
import { buildInboundEvent } from "./events.js";
import { resolveForCall } from "./answeredAgents.js";

const agentNum = (loc) => loc.match(/\d+/)?.[0] ?? loc; // same rule as agentWatcher
const looksLikeLoc = (s) => /^(Local|SIP|PJSIP|IAX2)\//i.test(s) || /^\d+$/.test(s);

const firstSeen = new Map(); // call id -> when the poller first saw a CONNECT row with no agent
const GRACE_MS = Number(process.env.ANSWERED_GRACE_SEC || 5) * 1000;

// "<product>\0<member name>" -> agent id (null if two locations share a name)
export async function loadAgentIds(pool) {
  const [rows] = await pool.query(
    "SELECT product_id, member_name, location FROM integration_agent_state WHERE member_name IS NOT NULL AND member_name <> ''");
  const m = new Map();
  for (const r of rows) {
    const k = `${r.product_id}\u0000${r.member_name.trim()}`;
    const id = agentNum(r.location);
    m.set(k, m.has(k) && m.get(k) !== id ? null : id);
  }
  return m;
}

export function buildAnsweredEvent(r, ep, config, agentIds, msisdnByCall) {
  const name = r.agent && r.agent !== "null" ? String(r.agent).trim() : null;
  const key = String(r.event_time);

  // who answered, from AMI AgentConnect (queue_log leaves the agent column empty until the call ends)
  const ami = resolveForCall(key, ep.product_id, Number(r.trx_id) * 1000);

  // only wait if we have no agent from either source yet
  if (!name && !ami) {
    const t = firstSeen.get(key) ?? Date.now();
    firstSeen.set(key, t);
    if (Date.now() - t < GRACE_MS) return null;
    if (firstSeen.size > 5000) firstSeen.clear();
  } else {
    firstSeen.delete(key);
  }

  // CONNECT rows often have no msisdn; take it from the call's ENTERQUEUE row (cached by the poller)
  const msisdn = msisdnByCall.get(key) || r.msisdn || null;

  if (process.env.ANSWERED_DEBUG === "1")
    console.log(`[answered] call=${r.event_time} agentCol=${JSON.stringify(r.agent)} ami=${ami ? ami.iface : null} msisdn=${msisdn} cached=${msisdnByCall.has(key)} mapSize=${agentIds.size}`);

  // borrow E.164 / started_at / call_id from the existing inbound builder
  const base = buildInboundEvent({ ...r, msisdn, event_name: "ENTERQUEUE" }, ep, config);
  if (!base) return null;
  const b = typeof base.payload === "string" ? JSON.parse(base.payload) : base.payload;

  const id = ami
    ? agentNum(ami.iface)
    : name
      ? (agentIds.get(`${ep.product_id}\u0000${name}`) ?? (looksLikeLoc(name) ? agentNum(name) : null))
      : null;
  const outName = name || ami?.name || null;
  if (id === null) console.warn(`[answered] no agent id for call=${b.call_id} tenant=${ep.product_id} agentCol=${JSON.stringify(r.agent)}`);

  const eventId = `answered:${b.call_id}`;
  const payload = {
    event_id: eventId, type: "call.answered", direction: "inbound",
    tenant: b.tenant, call_id: b.call_id,
    msisdn: b.msisdn, msisdn_raw: b.msisdn_raw,
    started_at: b.started_at,
    answered_at: new Date(Number(r.trx_id) * 1000).toISOString(), // trx_id = answer epoch
    wait_secs: r.delay_time == null ? null : Number(r.delay_time),
    agent: { id, ...(ep.expose_agent_name && outName ? { name: outName } : {}) },
  };
  return { eventId, eventType: "call.answered", payload: JSON.stringify(payload) };
}