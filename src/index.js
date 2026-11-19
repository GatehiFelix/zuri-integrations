import { config } from "./config.js";
import { pool } from "./db.js";
import { pollOnce } from "./poller.js";
import { startDeliveryWorker, sweepOrphans } from "./worker.js";
import { getQueue, closeRedis } from "./queue.js";

const log = (...a) => console.log(new Date().toISOString(), ...a);

// Self-rescheduling loop: a slow pass never overlaps the next one.
function startLoop(name, fn, intervalMs) {
  let timer = null;
  let running = Promise.resolve();
  let stopped = false;

  const tick = () => {
    running = (async () => {
      try {
        const res = await fn();
        if (res && (res.queued || res.enqueued))
          log(`[${name}]`, JSON.stringify(res));
      } catch (e) {
        console.error(new Date().toISOString(), `[${name}] error:`, e.message);
      }
      if (!stopped) timer = setTimeout(tick, intervalMs);
    })();
  };
  tick();

  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}

async function preflight() {
  await pool.query("SELECT 1 FROM integration_checkpoint LIMIT 1");
  await pool.query(`SELECT id FROM ${config.queueLogTable} LIMIT 1`);
  const redis = await getQueue().client;
  await redis.ping();
}

async function main() {
  try {
    await preflight();
  } catch (e) {
    console.error(
      `Startup check failed (schema applied? grants? QUEUE_LOG_TABLE? Redis reachable?): ${e.message}`,
    );
    process.exit(1);
  }
  log(
    `zuri-integrations up. queue_log=${config.queueLogTable} time_source=${config.timeSource}`,
  );

  const worker = startDeliveryWorker();
  const stops = [
    startLoop("poller", pollOnce, config.pollIntervalMs),
    startLoop("sweeper", sweepOrphans, config.sweepIntervalMs),
  ];

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${sig} received, draining...`);
    await Promise.all(stops.map((s) => s()));
    await worker.close(); // waits for in-flight deliveries
    await closeRedis();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
