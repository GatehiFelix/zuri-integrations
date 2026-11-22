import 'dotenv/config';

const env = process.env;

const int = (k, d) => {
  const n = parseInt(env[k], 10);
  return Number.isFinite(n) ? n : d;
};
const bool = (k, d = false) =>
  env[k] == null ? d : ['1', 'true', 'yes'].includes(String(env[k]).toLowerCase());

// table names are interpolated into SQL, so only allow plain identifiers
function tableRef(v) {
  if (!/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)?$/.test(v)) throw new Error(`Bad table name: ${v}`);
  return v.split('.').map((p) => `\`${p}\``).join('.');
}

const offset = env.QUEUE_LOG_TZ_OFFSET || '+03:00';
if (!/^([+-]\d{2}:\d{2}|Z)$/.test(offset)) throw new Error(`Bad QUEUE_LOG_TZ_OFFSET: ${offset}`);

const timeSource = env.TIME_SOURCE || 'call_id';
if (!['call_id', 'ingest', 'trx_id', 'event_time', 'created'].includes(timeSource)) {
  throw new Error(`Bad TIME_SOURCE: ${timeSource}`);
}

const dbFromEnv = () => {
  if (env.DB_URL) {
    let u;
    try { u = new URL(env.DB_URL); } catch { throw new Error('Bad DB_URL (expected mysql://user:pass@host:port/db)'); }
    if (u.protocol !== 'mysql:') throw new Error(`DB_URL must start with mysql:// (got ${u.protocol})`);
    return {
      host: u.hostname,
      port: u.port ? parseInt(u.port, 10) : 3306,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, '') || 'zuri_integrations',
    };
  }
  // legacy separate vars still work
  return {
    host: env.DB_HOST || '127.0.0.1',
    port: int('DB_PORT', 3306),
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME || 'zuri_integrations',
  };
}

export const config = Object.freeze({
    db: dbFromEnv(),
  queueLogTable: tableRef(env.QUEUE_LOG_TABLE || 'zuridev.queue_log'),
  timeSource,
  dbTzOffset: offset,

  pollIntervalMs: int('POLL_INTERVAL_MS', 2000),
  pollBatch: int('POLL_BATCH', 500),
  pollOverlap: int('POLL_OVERLAP', 200),
  pollBackfill: bool('POLL_BACKFILL', false),

  redisUrl: env.REDIS_URL || 'redis://127.0.0.1:6379',
  queuePrefix: env.QUEUE_PREFIX || 'zuri-int',
  workerConcurrency: int('WORKER_CONCURRENCY', 5),
  httpTimeoutMs: int('HTTP_TIMEOUT_MS', 10000),
  maxAttempts: int('MAX_ATTEMPTS', 15),
  sweepIntervalMs: int('SWEEP_INTERVAL_MS', 30000),
  sweepOverdueSec: int('SWEEP_OVERDUE_SEC', 120),
  backoffBaseSec: int('BACKOFF_BASE_SEC', 10),
  backoffCapSec: int('BACKOFF_CAP_SEC', 3600),
  allowHttp: bool('ALLOW_HTTP', false),
});