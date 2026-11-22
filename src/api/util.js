import { ApiError } from "./errors.js";

export const ISO = "'%Y-%m-%dT%H:%i:%sZ'"; // SQL DATE_FORMAT: DATETIMEs are stored in UTC (Sequelize default)
export const DEFAULT_LIMIT = 500;
export const MAX_LIMIT = 1000;

const TZ_RE = /(Z|[+-]\d\d:?\d\d)$/i;

// async route handler wrapper: rejected promises go to the error middleware
export const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// query-string values can be arrays/objects; only accept plain strings
export const str = (v) => (typeof v === "string" ? v : undefined);

// 'YYYY-MM-DD HH:MM:SS' (UTC) -> ISO 8601
export const toIso = (dt) => `${dt.replace(" ", "T")}Z`;

export function parseLimit(v) {
  if (v === undefined) return DEFAULT_LIMIT;
  const s = str(v);
  if (!s || !/^\d+$/.test(s)) throw new ApiError(400, "invalid_request", "limit must be an integer");
  const n = Number(s);
  if (n < 1 || n > MAX_LIMIT)
    throw new ApiError(400, "invalid_request", `limit must be between 1 and ${MAX_LIMIT}`);
  return n;
}

// ISO 8601 with an explicit timezone -> 'YYYY-MM-DD HH:MM:SS' (UTC)
export function parseSince(v) {
  const s = str(v);
  if (!s || !TZ_RE.test(s) || Number.isNaN(new Date(s).getTime()))
    throw new ApiError(
      400,
      "invalid_request",
      "updated_since must be an ISO 8601 timestamp with a timezone, e.g. 2026-11-20T00:00:00Z",
    );
  return new Date(s).toISOString().slice(0, 19).replace("T", " ");
}