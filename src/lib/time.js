// "2026-01-08 12:22:13" in the DB's wall clock -> UTC ISO string
export function naiveToIso(s, offset) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(String(s ?? ''));
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}${offset}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Epoch seconds out of an Asterisk call id like "1795026655.23014".
export function callIdEpochIso(callId) {
  const n = Number(String(callId ?? '').split('.')[0]);
  return Number.isFinite(n) && n > 1e9 && n < 4e9 ? new Date(n * 1000).toISOString() : null;
}

// Prod check (2026-11-18): trx_id == created to the second (epoch, tz-proof); event_time holds the
// Asterisk call id whose epoch prefix is the call start (~1s before the ENTERQUEUE row is written).
// Returns null when the chosen source is unusable.
export function startedAt(source, row, dbOffset, now = new Date()) {
  switch (source) {
    case 'call_id':
      return callIdEpochIso(row.event_time);
    case 'trx_id': {
      const n = Number(row.trx_id);
      return Number.isFinite(n) && n > 1e9 && n < 4e9 ? new Date(n * 1000).toISOString() : null;
    }
    case 'event_time':
      return naiveToIso(row.event_time, dbOffset);
    case 'created':
      return naiveToIso(row.created, dbOffset);
    default:
      return now.toISOString();
  }
}