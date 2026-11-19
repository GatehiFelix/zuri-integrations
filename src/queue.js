import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from './config.js';

export const QUEUE_NAME = 'deliveries';

// BullMQ rejects integer ids and ids containing ":", so outbox id 42 becomes "ob-42".
// Same id = same job, which is what makes re-adding (poller retry, sweeper) harmless.
export const jobIdFor = (outboxId) => `ob-${outboxId}`;

const onError = (name) => (e) => console.error(`[redis:${name}]`, e.message);

// BullMQ does not close connections it is handed, so we track them and quit them ourselves on shutdown.
const connections = new Set();
const track = (c) => (connections.add(c), c);

// Producer side: fail fast when Redis is down so the poller can log it and move on
// (the sweeper re-enqueues anything that didn't make it).
let queue = null;
export function getQueue() {
  if (!queue) {
    const connection = track(new IORedis(config.redisUrl, { maxRetriesPerRequest: 2 }));
    connection.on('error', onError('queue'));
    queue = new Queue(QUEUE_NAME, {
      connection,
      prefix: config.queuePrefix,
      defaultJobOptions: {
        attempts: config.maxAttempts,
        backoff: { type: 'custom' },
        // The outbox is the record of what happened; jobs are just delivery attempts.
        // Failed jobs are removed so the sweeper can always re-add a still-pending row.
        removeOnComplete: true,
        removeOnFail: true,
      },
    });
    queue.on('error', onError('queue'));
  }
  return queue;
}

// Consumer side: BullMQ requires maxRetriesPerRequest: null for blocking connections.
export function createWorkerConnection() {
  const connection = track(new IORedis(config.redisUrl, { maxRetriesPerRequest: null }));
  connection.on('error', onError('worker'));
  return connection;
}

export async function enqueue(outboxIds) {
  if (!outboxIds.length) return;
  await getQueue().addBulk(
    outboxIds.map((id) => ({ name: 'deliver', data: { outboxId: id }, opts: { jobId: jobIdFor(id) } })),
  );
}

// Call after the worker has been closed.
export async function closeRedis() {
  if (queue) {
    await queue.close();
    queue = null;
  }
  await Promise.all([...connections].map((c) => c.quit().catch(() => c.disconnect())));
  connections.clear();
}