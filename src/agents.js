import "./config.js"; // loads dotenv
import { pool } from "./db.js";
import { closeRedis } from "./queue.js";
import { startAgentWatcher } from "./ami/agentWatcher.js";

startAgentWatcher().catch((e) => {
  console.error("agent watcher failed to start:", e.message);
  process.exit(1);
});

const shutdown = async () => {
  await closeRedis().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);