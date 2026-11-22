import crypto from "node:crypto";
import { ApiError } from "./errors.js";

// Key format: zk_<8 hex prefix>_<32 hex secret>
const KEY_RE = /^zk_([a-f0-9]{8})_([a-f0-9]{32})$/;

export const hashKey = (key) =>
  crypto.createHash("sha256").update(key).digest("hex");

export function generateKey() {
  const prefix = crypto.randomBytes(4).toString("hex");
  const secret = crypto.randomBytes(16).toString("hex");
  const key = `zk_${prefix}_${secret}`;
  return { key, prefix, hash: hashKey(key) };
}

// Bearer auth. Sets req.tenant (product_id) and req.keyPrefix.
export function makeAuth(pool) {
  return async function auth(req, _res, next) {
    try {
      const m = /^Bearer (\S+)$/.exec(req.get("authorization") || "");
      const parts = m && KEY_RE.exec(m[1]);
      if (!parts) throw new ApiError(401, "invalid_api_key", "Missing or invalid API key");

      const [rows] = await pool.query(
        "SELECT product_id, key_hash, status FROM integration_api_keys WHERE key_prefix = ? LIMIT 1",
        [parts[1]],
      );
      const row = rows[0];
      let ok = false;
      if (row && row.status === "active") {
        const a = Buffer.from(hashKey(m[1]), "hex");
        const b = Buffer.from(String(row.key_hash), "hex");
        ok = a.length === b.length && crypto.timingSafeEqual(a, b);
      }
      if (!ok) throw new ApiError(401, "invalid_api_key", "Missing or invalid API key");

      req.tenant = Number(row.product_id);
      req.keyPrefix = parts[1];

      // best-effort, at most one write per key per minute
      pool
        .query(
          "UPDATE integration_api_keys SET last_used_at = NOW() WHERE key_prefix = ? AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL 60 SECOND)",
          [parts[1]],
        )
        .catch(() => {});
      next();
    } catch (e) {
      next(e);
    }
  };
}

// Fixed window per key, in memory (single process). Swap for Redis if the API is ever split out.
export function makeRateLimit({ limit = 60, windowMs = 60_000, now = Date.now } = {}) {
  const buckets = new Map();
  return function rateLimit(req, res, next) {
    const t = now();
    let b = buckets.get(req.keyPrefix);
    if (!b || t - b.start >= windowMs) {
      b = { start: t, count: 0 };
      buckets.set(req.keyPrefix, b);
    }
    b.count += 1;
    const remaining = Math.max(0, limit - b.count);
    res.set("X-RateLimit-Limit", String(limit));
    res.set("X-RateLimit-Remaining", String(remaining));
    if (b.count > limit) {
      const retry = Math.max(1, Math.ceil((b.start + windowMs - t) / 1000));
      return next(
        new ApiError(429, "rate_limited", "Too many requests", { "Retry-After": String(retry) }),
      );
    }
    next();
  };
}