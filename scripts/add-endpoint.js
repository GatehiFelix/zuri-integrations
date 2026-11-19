// node scripts/add-endpoint.js --product 4000 --url https://client.example/hooks/zuri [--cc 254] [--rotate]
// Creates (or updates) a tenant endpoint and prints the signing secret ONCE. Hand it to the client securely.
import { parseArgs } from 'node:util';
import crypto from 'node:crypto';
import { pool } from '../src/db.js';

const { values } = parseArgs({
  options: {
    product: { type: 'string' },
    url: { type: 'string' },
    cc: { type: 'string', default: '254' },
    events: { type: 'string', default: 'call.inbound' },
    rotate: { type: 'boolean', default: false },
    disable: { type: 'boolean', default: false },
  },
});

if (!/^\d+$/.test(values.product ?? '')) {
  console.error('--product <numeric product_id (= queue_id)> is required');
  process.exit(1);
}

try {
  const [rows] = await pool.query('SELECT id FROM integration_endpoints WHERE product_id = ?', [values.product]);

  if (values.disable) {
    await pool.query('UPDATE integration_endpoints SET enabled = 0 WHERE product_id = ?', [values.product]);
    console.log(`product ${values.product}: disabled`);
  } else if (rows.length === 0) {
    if (!values.url) throw new Error('--url is required for a new endpoint');
    const secret = crypto.randomBytes(32).toString('hex');
    await pool.query(
      'INSERT INTO integration_endpoints (product_id, url, secret, default_country_code, event_types) VALUES (?, ?, ?, ?, ?)',
      [values.product, values.url, secret, values.cc, values.events],
    );
    console.log(`product ${values.product}: created\nsecret (shown once): ${secret}`);
  } else {
    const sets = ['enabled = 1'];
    const args = [];
    if (values.url) (sets.push('url = ?'), args.push(values.url));
    if (values.rotate) {
      var secret = crypto.randomBytes(32).toString('hex');
      sets.push('secret = ?');
      args.push(secret);
    }
    await pool.query(`UPDATE integration_endpoints SET ${sets.join(', ')} WHERE product_id = ?`, [...args, values.product]);
    console.log(`product ${values.product}: updated${secret ? `\nnew secret (shown once): ${secret}` : ''}`);
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}