import http from 'node:http';

// Minimal stand-in for the mysql2 pool: understands only the statements worker.js issues.
export class FakeDb {
  constructor() {
    this.outbox = new Map(); // id -> row
    this.log = []; // delivery_log inserts
    this.parked = new Set();
  }

  addRow(id, overrides = {}) {
    this.outbox.set(id, {
      id,
      event_id: `inbound:4000:${id}:254722636638`,
      payload: JSON.stringify({ event_id: `e${id}`, type: 'call.inbound' }),
      attempts: 0,
      status: 'pending',
      last_error: null,
      url: null,
      secret: 'test-secret',
      enabled: 1,
      ...overrides,
    });
    return this.outbox.get(id);
  }

  async query(sql, params = []) {
    if (/SELECT o\.id/.test(sql)) {
      const r = this.outbox.get(params[0]);
      return [r ? [{ ...r }] : []];
    }
    if (/SELECT id FROM integration_outbox/.test(sql)) {
      return [[...this.outbox.values()].filter((r) => r.status === 'pending').map((r) => ({ id: r.id }))];
    }
    if (/INSERT INTO integration_delivery_log/.test(sql)) {
      const [outbox_id, attempt, status_code, error] = params;
      this.log.push({ outbox_id, attempt, status_code, error });
      return [{}];
    }
    if (/SET status = 'sent'/.test(sql)) {
      Object.assign(this.outbox.get(params[1]), { status: 'sent', attempts: params[0], last_error: null });
      return [{}];
    }
    if (/SET status = 'dead'/.test(sql)) {
      Object.assign(this.outbox.get(params[2]), { status: 'dead', attempts: params[0], last_error: params[1] });
      return [{}];
    }
    if (/SET attempts = \?, last_error = \?, next_attempt_at/.test(sql)) {
      const r = this.outbox.get(params[3]);
      Object.assign(r, { attempts: params[0], last_error: params[1], delaySec: params[2] });
      return [{}];
    }
    if (/INTERVAL 300 SECOND/.test(sql)) {
      this.parked.add(params[1]);
      this.outbox.get(params[1]).last_error = params[0];
      return [{}];
    }
    throw new Error(`FakeDb: unhandled SQL: ${sql}`);
  }
}

// Local endpoint. `respond(req, body)` returns a status code.
export async function startServer(respond) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ headers: req.headers, body });
      res.writeHead(respond(requests.length, req, body)).end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}/hook`,
    requests,
    close: () => new Promise((r) => server.close(r)),
  };
}

export const waitFor = async (cond, { timeoutMs = 15000, everyMs = 50 } = {}) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error('waitFor timed out');
};