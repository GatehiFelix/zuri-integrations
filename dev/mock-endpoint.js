// Stand-in for the client's endpoint. MOCK_SECRET=<secret> [FAIL_RATE=0.3] [PORT=4000] node dev/mock-endpoint.js
// Verifies the signature exactly the way the client should, dedupes on event id, and can fail on purpose.
import http from 'node:http';
import { verify } from '../src/lib/sign.js';

const secret = process.env.MOCK_SECRET;
const failRate = Number(process.env.FAIL_RATE || 0);
const port = Number(process.env.PORT || 4000);
if (!secret) {
  console.error('MOCK_SECRET is required');
  process.exit(1);
}

const seen = new Set();

http
  .createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const ok = verify(secret, req.headers['x-zuri-timestamp'], body, req.headers['x-zuri-signature']);
      if (!ok) {
        console.log('REJECT bad signature');
        res.writeHead(401).end();
        return;
      }
      if (Math.random() < failRate) {
        console.log('FAIL   (simulated 503)', req.headers['x-zuri-event-id']);
        res.writeHead(503).end();
        return;
      }
      const id = req.headers['x-zuri-event-id'];
      console.log(seen.has(id) ? 'DUP   ' : 'OK    ', body);
      seen.add(id);
      res.writeHead(200).end('ok');
    });
  })
  .listen(port, () => console.log(`mock endpoint on :${port} (fail rate ${failRate})`));