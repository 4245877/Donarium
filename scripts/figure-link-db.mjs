// Executed over stdin by scripts/figure-link-admin.py inside the existing app container.
// No configuration, originals, or application code is changed by this helper.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import pg from 'pg';

const args = JSON.parse(process.env.FIGURE_LINK_ARGUMENTS || '{}');
const url = new URL(process.env.DATABASE_URL);
assert.equal(url.pathname, '/donarium', 'Expected dedicated production database');
if (args.database) {
  assert.match(args.database, /^donarium_autolink_verify_\d+$/);
  url.pathname = `/${args.database}`;
}
const pool = new pg.Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 5000 });
const client = await pool.connect();
try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r => r.tablename);
  const data = {}, fingerprints = {};
  for (const table of tables) {
    assert.match(table, /^[a-z_]+$/);
    const result = await client.query(`SELECT to_jsonb(t)::text AS data FROM "${table}" t ORDER BY to_jsonb(t)::text COLLATE "C"`);
    const hash = createHash('sha256');
    data[table] = result.rows.map(row => { hash.update(row.data + '\n'); return JSON.parse(row.data); });
    fingerprints[table] = { count: result.rows.length, sha256: hash.digest('hex') };
  }
  await client.query('ROLLBACK');
  console.log(JSON.stringify({ at: new Date().toISOString(), fingerprints, ...(args.fingerprintsOnly ? {} : { data }) }));
} finally {
  client.release();
  await pool.end();
}
