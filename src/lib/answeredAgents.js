const byQueue = new Map(); // queue -> [{ iface, name, at }]
const resolved = new Map(); // call key -> { iface, name }

export function noteAnswered(queue, iface, name) {
  const q = String(queue);
  const now = Date.now();
  const a = (byQueue.get(q) ?? []).filter((x) => now - x.at < 120_000);
  a.push({ iface, name, at: now });
  byQueue.set(q, a);
}

// nearest AgentConnect on this queue to the answer time; remembered per call so
// the poller's overlap re-reads of the same row can't pick a different one
export function resolveForCall(callKey, queue, answeredAtMs, windowMs = 15_000) {
  if (resolved.has(callKey)) return resolved.get(callKey);
  const a = byQueue.get(String(queue));
  if (!a?.length) return null;
  let best = null, bd = Infinity;
  for (const x of a) {
    const d = Math.abs(x.at - answeredAtMs);
    if (d < bd) { bd = d; best = x; }
  }
  if (!best || bd > windowMs) return null;
  if (resolved.size > 2000) resolved.delete(resolved.keys().next().value);
  resolved.set(callKey, best);
  return best;
}