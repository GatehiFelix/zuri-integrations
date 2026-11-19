// attempts = number of attempts already made (>= 1). 10s, 20s, 40s ... capped, +/- jitter.
export function nextDelaySec(attempts, { base = 10, cap = 3600, jitter = 0.2 } = {}, rnd = Math.random) {
  const d = Math.min(cap, base * 2 ** Math.max(attempts - 1, 0));
  return Math.max(1, Math.round(d * (1 + (rnd() * 2 - 1) * jitter)));
}