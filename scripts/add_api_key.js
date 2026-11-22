// node scripts/add-api-key.js <product_id> [label]     -> creates a key, prints it ONCE
// node scripts/add-api-key.js revoke <key_prefix>      -> revokes by prefix (the 8 chars after zk_)
import { pool } from "../src/db.js";
import { generateKey } from "../src/api/auth.js";

const [a, b] = process.argv.slice(2);

try {
  if (a === "revoke") {
    if (!b) throw new Error("usage: add-api-key.js revoke <key_prefix>");
    const [r] = await pool.query(
      "UPDATE integration_api_keys SET status='revoked', revoked_at=NOW() WHERE key_prefix=? AND status='active'",
      [b],
    );
    console.log(r.affectedRows ? `revoked ${b}` : `no active key with prefix ${b}`);
  } else {
    if (!/^\d+$/.test(a || "")) throw new Error("usage: add-api-key.js <product_id> [label]");
    const { key, prefix, hash } = generateKey();
    await pool.query(
      "INSERT INTO integration_api_keys (product_id, key_prefix, key_hash, label) VALUES (?,?,?,?)",
      [Number(a), prefix, hash, b || null],
    );
    console.log(`product ${a}  prefix ${prefix}`);
    console.log(`API key (shown once, store it now):\n${key}`);
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}