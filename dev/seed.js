// Simulates calls in the dev queue_log table (no PBX needed):
//   node dev/seed.js --yes [--queue 4000] [--msisdn 254722636638]
// Writes the same row shapes your real queue_log shows: ENTERQUEUE twice, then CONNECT, COMPLETEAGENT,
// plus an anonymous ABANDON. Refuses to run against the real zuridev schema.
import { parseArgs } from 'node:util';
import { pool } from '../src/db.js';
import { config } from '../src/config.js';

const { values } = parseArgs({
  options: {
    yes: { type: 'boolean', default: false },
    queue: { type: 'string', default: '4000' },
    msisdn: { type: 'string', default: '254722636638' },
  },
});

if (!values.yes) {
  console.error('pass --yes to confirm');
  process.exit(1);
}
if (!/_dev`?$/.test(config.queueLogTable)) {
  console.error(`refusing: QUEUE_LOG_TABLE=${config.queueLogTable} is not a *_dev table`);
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
// event_time on prod is the Asterisk call id "<epoch>.<seq>", shared by every row of one call.
const seq = () => 10000 + Math.floor(Math.random() * 9000);
const callA = `${now}.${seq()}`;
const callB = `${now + 80}.${seq()}`;
const row = (offset, callId, event, agent, msisdn, extra = {}) => [
  now + offset, callId, values.queue, agent, event, extra.delay ?? null, msisdn, extra.pos ?? null, extra.len ?? 0, stamp,
];

const rows = [
  row(1, callA, 'ENTERQUEUE', 'null', values.msisdn, { pos: 1 }),
  row(1, callA, 'ENTERQUEUE', 'null', values.msisdn, { pos: 1 }),
  row(4, callA, 'CONNECT', 'Test Agent', null, { delay: 3 }),
  row(73, callA, 'COMPLETEAGENT', 'Test Agent', null, { delay: 3, pos: 1, len: 69 }),
  row(81, callB, 'ENTERQUEUE', 'null', null, { pos: 1 }),
  row(81, callB, 'ENTERQUEUE', 'null', null, { pos: 1 }),
  row(99, callB, 'ABANDON', 'null', null, { delay: 18, pos: 1 }),
];

try {
  await pool.query(
    `INSERT INTO ${config.queueLogTable}
       (trx_id, event_time, queue_id, agent, event_name, delay_time, msisdn, queue_pos, call_len, created)
     VALUES ?`,
    [rows],
  );
  console.log(`inserted ${rows.length} rows into ${config.queueLogTable}`);
} finally {
  await pool.end();
}