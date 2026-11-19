import { toE164 } from './phone.js';
import { startedAt } from './time.js';

const BLANK = new Set(['', 'null', 'undefined']);
// Asterisk call id as it appears in queue_log.event_time on prod: "<epoch>.<seq>"
const CALL_ID = /^\d{9,11}\.\d+$/;

// One call.inbound event per ENTERQUEUE row. Returns null for rows that aren't ENTERQUEUE.
// event_id is the idempotency key. The PBX writes ENTERQUEUE twice per call and retries re-send, but all
// rows of a call share the Asterisk call id (queue_log.event_time), so event_id = inbound:<call id>
// collapses them into one event and never merges two different callers. Rows without a usable call id
// fall back to queue:trx_id:msisdn (anonymous callers in the same second could merge there).
export function buildInboundEvent(row, endpoint, cfg, now = new Date()) {
  if (String(row.event_name).toUpperCase() !== 'ENTERQUEUE') return null;

  const rawStr = row.msisdn == null ? '' : String(row.msisdn).trim();
  const msisdnRaw = BLANK.has(rawStr.toLowerCase()) ? null : rawStr;

  const queue = String(row.queue_id).trim();
  const callId = CALL_ID.test(String(row.event_time ?? '').trim()) ? String(row.event_time).trim() : null;
  const eventId = callId ? `inbound:${callId}` : `inbound:${queue}:${row.trx_id}:${msisdnRaw ?? 'anon'}`;

  const started =
    startedAt(cfg.timeSource, row, cfg.dbTzOffset, now) ?? startedAt('trx_id', row, cfg.dbTzOffset, now) ?? now.toISOString();

  const payload = {
    event_id: eventId,
    type: 'call.inbound',
    direction: 'inbound',
    tenant: String(endpoint.product_id),
    call_id: callId,
    msisdn: msisdnRaw ? toE164(msisdnRaw, endpoint.default_country_code || '254') : null,
    msisdn_raw: msisdnRaw,
    started_at: started,
  };

  return { eventId, eventType: 'call.inbound', payload: JSON.stringify(payload) };
}