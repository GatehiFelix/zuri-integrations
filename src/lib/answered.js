// src/lib/answered.js
import { buildInboundEvent } from "./events.js";

const agentNum = (loc) => loc.match(/\d+/)?.[0] ?? loc; // same rule as agentWatcher

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
  // CONNECT rows often have no msisdn; take it from the call's ENTERQUEUE row (cached by the poller)
  const msisdn = msisdnByCall.get(String(r.event_time)) || r.msisdn || null;

  if (process.env.ANSWERED_DEBUG === "1")
    console.log(`[answered] call=${r.event_time} agentCol=${JSON.stringify(r.agent)} msisdn=${msisdn} cached=${msisdnByCall.has(String(r.event_time))} mapSize=${agentIds.size}`);

  // borrow E.164 / started_at / call_id from the existing inbound builder
  const base = buildInboundEvent({ ...r, msisdn, event_name: "ENTERQUEUE" }, ep, config);
  if (!base) return null;
  const b = typeof base.payload === "string" ? JSON.parse(base.payload) : base.payload;

  const id = name ? agentIds.get(`${ep.product_id}\u0000${name}`) ?? null : null;
  if (name && id === null) console.warn(`[answered] no agent id for "${name}" tenant=${ep.product_id} call=${b.call_id}`);

  const eventId = `answered:${b.call_id}`;
  const payload = {
    event_id: eventId, type: "call.answered", direction: "inbound",
    tenant: b.tenant, call_id: b.call_id,
    msisdn: b.msisdn, msisdn_raw: b.msisdn_raw,
    started_at: b.started_at,
    answered_at: new Date(Number(r.trx_id) * 1000).toISOString(), // trx_id = answer epoch
    wait_secs: r.delay_time == null ? null : Number(r.delay_time),
    agent: { id, ...(ep.expose_agent_name && name ? { name } : {}) }, // same shape as agent.* events
  };
  return { eventId, eventType: "call.answered", payload: JSON.stringify(payload) };
}