import http from 'node:http';
import crypto from 'node:crypto';
const SECRET = process.env.SECRET || 'devsecret';   // must match the tenant's secret in your integration config
let fail = process.env.FAIL === '1';
http.createServer((req, res) => {
  let b = '';
  req.on('data', d => (b += d));
  req.on('end', () => {
    const ts = req.headers['x-zuri-timestamp'];
    const sig = req.headers['x-zuri-signature'] || '';
    const exp = crypto.createHmac('sha256', SECRET).update(`${ts}.${b}`).digest('hex');
    const ok = sig.endsWith(exp);
    console.log(new Date().toISOString(), req.headers['x-zuri-event-id'], 'sig', ok ? 'OK' : 'BAD', b);
    res.statusCode = fail ? 500 : 200;
    res.end('{}');
  });
}).listen(4000, () => console.log('mock on :4000'));