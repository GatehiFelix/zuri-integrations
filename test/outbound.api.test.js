// Tests the API logic (auth, validation, cursors, rate limit) against an in-memory fake pool.
// The SQL itself is exercised by the local MariaDB run (see README steps), not here.
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/api/app.js";
import { generateKey } from "../src/api/auth.js";

const good = generateKey();
const revoked = generateKey();
const keys = {
  [good.prefix]: { product_id: 6000, key_hash: good.hash, status: "active" },
  [revoked.prefix]: { product_id: 6000, key_hash: revoked.hash, status: "revoked" },
};

const campaigns = [
  { campaign_id: 1, tenant: 6000, name: "Nov Renewals", status: "active", created_at: "2026-11-01T08:00:00Z" },
  { campaign_id: 2, tenant: 6000, name: "Old", status: "deleted", created_at: "2026-09-01T08:00:00Z" },
  { campaign_id: 3, tenant: 7000, name: "Other tenant", status: "active", created_at: "2026-11-01T08:00:00Z" },
];
const mk = (id, cid, del, changed) => ({
  contact_id: id, tenant: cid === 3 ? 7000 : 6000, campaign_id: cid, msisdn: `07120000${id}`,
  created_at: "2026-11-01T09:00:00Z", actioned_at: null, is_deleted: del ? 1 : 0, changed_at: changed,
});
const contacts = [
  mk(10, 1, false, "2026-11-01 09:00:00"),
  mk(11, 1, false, "2026-11-05 10:00:00"),
  mk(12, 1, true, "2026-11-06 11:00:00"),
  mk(13, 1, false, "2026-11-06 11:00:00"),
  mk(14, 1, false, "2026-11-07 12:00:00"),
  mk(20, 2, false, "2026-09-02 09:00:00"),
  mk(30, 3, false, "2026-11-01 09:00:00"),
];

function fakePool() {
  return {
    async query(sql, p = []) {
      if (sql.includes("FROM integration_api_keys")) return [keys[p[0]] ? [keys[p[0]]] : []];
      if (sql.startsWith("UPDATE integration_api_keys")) return [{ affectedRows: 1 }];
      if (sql.includes("FROM v_export_account")) return [[{ prefix: "80, 10, 6" }]];
      if (sql.includes("FROM v_export_campaigns") && sql.includes("campaign_id = ?"))
        return [campaigns.filter((c) => c.tenant === p[0] && c.campaign_id === p[1])];
      if (sql.includes("FROM v_export_campaigns"))
        return [campaigns.filter((c) => c.tenant === p[0] && (!sql.includes("status = 'active'") || c.status === "active"))];
      if (sql.includes("FROM v_export_contacts") && sql.includes("changed_at >")) {
        const [tenant, cid, t, , pid, n] = p;
        const rows = contacts
          .filter((r) => r.tenant === tenant && r.campaign_id === cid && (r.changed_at > t || (r.changed_at === t && r.contact_id > pid)))
          .sort((a, b) => (a.changed_at === b.changed_at ? a.contact_id - b.contact_id : a.changed_at < b.changed_at ? -1 : 1));
        return [rows.slice(0, n)];
      }
      if (sql.includes("FROM v_export_contacts")) {
        const [tenant, cid, after, n] = p;
        return [contacts
          .filter((r) => r.tenant === tenant && r.campaign_id === cid && !r.is_deleted && r.contact_id > after)
          .sort((a, b) => a.contact_id - b.contact_id)
          .slice(0, n)];
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
}

async function withServer(opts, fn) {
  const server = createApp({ pool: fakePool(), ...opts }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, k = good.key) => {
    const res = await fetch(base + path, { headers: k ? { Authorization: `Bearer ${k}` } : {} });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  try { await fn(call); } finally { server.close(); }
}

test("auth: missing, malformed, unknown and revoked keys are 401", async () => {
  await withServer({}, async (call) => {
    assert.equal((await call("/v1/account", null)).status, 401);
    assert.equal((await call("/v1/account", "nonsense")).status, 401);
    assert.equal((await call("/v1/account", "zk_deadbeef_" + "0".repeat(32))).status, 401);
    assert.equal((await call("/v1/account", revoked.key)).status, 401);
    const wrongSecret = `zk_${good.prefix}_${"1".repeat(32)}`;
    assert.equal((await call("/v1/account", wrongSecret)).status, 401);
    assert.equal((await call("/v1/account")).status, 200);
  });
});

test("account returns split prefixes", async () => {
  await withServer({}, async (call) => {
    assert.deepEqual((await call("/v1/account")).body, { tenant: 6000, prefixes: ["80", "10", "6"] });
  });
});

test("campaigns: deleted hidden by default", async () => {
  await withServer({}, async (call) => {
    const a = await call("/v1/campaigns");
    assert.deepEqual(a.body.data.map((c) => c.id), [1]);
    const b = await call("/v1/campaigns?include_deleted=true");
    assert.deepEqual(b.body.data.map((c) => c.id), [1, 2]);
  });
});

test("contacts full mode: paginates, hides deleted, exact field whitelist", async () => {
  await withServer({}, async (call) => {
    const ids = [];
    let cursor = null;
    let pages = 0;
    do {
      const r = await call(`/v1/campaigns/1/contacts?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      assert.equal(r.status, 200);
      for (const row of r.body.data) {
        assert.deepEqual(Object.keys(row).sort(), ["actioned_at", "created_at", "id", "msisdn"]);
        ids.push(row.id);
      }
      cursor = r.body.next_cursor;
      pages += 1;
      assert.equal(r.body.has_more, cursor !== null);
    } while (cursor && pages < 10);
    assert.deepEqual(ids, [10, 11, 13, 14]); // 12 is deleted
    assert.equal(pages, 2);
  });
});

test("contacts: foreign and deleted campaigns are 404 in full mode", async () => {
  await withServer({}, async (call) => {
    assert.equal((await call("/v1/campaigns/3/contacts")).status, 404);
    assert.equal((await call("/v1/campaigns/999/contacts")).status, 404);
    assert.equal((await call("/v1/campaigns/abc/contacts")).status, 404);
    assert.equal((await call("/v1/campaigns/2/contacts")).status, 404);
    assert.equal((await call("/v1/campaigns/3/contacts?updated_since=2020-01-01T00:00:00Z")).status, 404);
  });
});

test("contacts delta mode: tombstones, ties, pagination and watermark", async () => {
  await withServer({}, async (call) => {
    const r1 = await call("/v1/campaigns/1/contacts?updated_since=2026-11-05T00:00:00Z&limit=2");
    assert.equal(r1.status, 200);
    assert.deepEqual(r1.body.data.map((r) => [r.id, r.deleted]), [[11, false], [12, true]]);
    assert.equal(r1.body.has_more, true);
    const r2 = await call(`/v1/campaigns/1/contacts?cursor=${r1.body.next_cursor}&limit=2`);
    assert.deepEqual(r2.body.data.map((r) => [r.id, r.deleted]), [[13, false], [14, false]]);
    assert.equal(r2.body.has_more, false);
    assert.equal(r2.body.next_updated_since, "2026-11-07T12:00:00Z");

    // nothing new since the watermark except the boundary row (>= semantics via keyset from id 0)
    const r3 = await call(`/v1/campaigns/1/contacts?updated_since=${encodeURIComponent("2026-11-08T00:00:00Z")}`);
    assert.deepEqual(r3.body.data, []);
    assert.equal(r3.body.next_updated_since, "2026-11-08T00:00:00Z");

    // deleted campaign is visible in delta mode (tombstones)
    const r4 = await call("/v1/campaigns/2/contacts?updated_since=2020-01-01T00:00:00Z");
    assert.equal(r4.status, 200);
  });
});

test("validation errors are 400 with the error envelope", async () => {
  await withServer({}, async (call) => {
    for (const q of ["limit=0", "limit=1001", "limit=abc", "updated_since=2026-11-05", "updated_since=garbage", "cursor=%%%", "cursor=eyJ9"]) {
      const r = await call(`/v1/campaigns/1/contacts?${q}`);
      assert.equal(r.status, 400, q);
      assert.equal(r.body.error.code, "invalid_request");
    }
    // cursor minted for campaign 1 cannot be replayed on another campaign
    const page = await call("/v1/campaigns/1/contacts?limit=1");
    const bad = await call(`/v1/campaigns/2/contacts?updated_since=2020-01-01T00:00:00Z&cursor=${page.body.next_cursor}`);
    assert.equal(bad.status, 400);
  });
});

test("rate limit: 429 with Retry-After after the limit, window resets", async () => {
  let t = 1_000_000;
  await withServer({ rateLimit: 2, now: () => t }, async (call) => {
    assert.equal((await call("/v1/account")).status, 200);
    assert.equal((await call("/v1/account")).status, 200);
    const r = await call("/v1/account");
    assert.equal(r.status, 429);
    assert.equal(r.body.error.code, "rate_limited");
    assert.ok(Number(r.headers.get("retry-after")) >= 1);
    t += 61_000;
    assert.equal((await call("/v1/account")).status, 200);
  });
});

test("unknown route is a JSON 404", async () => {
  await withServer({}, async (call) => {
    const r = await call("/v1/nope");
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, "not_found");
  });
});