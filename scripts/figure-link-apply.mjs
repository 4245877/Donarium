// This maintenance module is sent over stdin to the running app container.
// The Python launcher prepends a validated `plan` object; credentials stay inside Docker.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadConfig } from '/app/apps/api/dist/config.js';
import { StorageService } from '/app/apps/api/dist/storage/service.js';
import { saveFigureFile } from '/app/apps/api/dist/storage/figure.js';

const args = JSON.parse(process.env.FIGURE_LINK_ARGUMENTS || '{}');
assert.ok(['rehearse', 'apply', 'rollback'].includes(args.action));
const config = loadConfig();
assert.equal(new URL(config.databaseUrl).pathname, '/donarium');
const service = new StorageService(config);
assert.equal(service.root('LIBRARY').path, '/app/storage/library');
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
const client = await pool.connect();
const canonical = value => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
async function fingerprints() {
  const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const result = {};
  for (const { tablename: table } of tables) {
    assert.match(table, /^[a-z_]+$/);
    const rows = (await client.query(`SELECT to_jsonb(t)::text AS data FROM "${table}" t ORDER BY to_jsonb(t)::text COLLATE "C"`)).rows;
    const hash = createHash('sha256');
    for (const row of rows) hash.update(row.data + '\n');
    result[table] = { count: rows.length, sha256: hash.digest('hex') };
  }
  return result;
}
async function checkOriginal(row) {
  const opened = await service.open(row.root, row.path);
  try {
    const stat = await opened.handle.stat({ bigint: true });
    assert.equal(String(stat.size), String(row.fingerprint.size), `Changed size: ${row.path}`);
    assert.equal(String(stat.mtimeNs), row.fingerprint.mtime_ns, `Changed mtime: ${row.path}`);
    assert.equal(String(stat.ctimeNs), row.fingerprint.ctime_ns, `Changed ctime: ${row.path}`);
    assert.equal(String(stat.ino), String(row.fingerprint.inode), `Changed inode: ${row.path}`);
  } finally { await opened.handle.close(); }
}
// The normal interactive helper updates updated_at when attaching. Maintenance
// must preserve every product column, including this timestamp. This narrow
// adapter suppresses only that known bookkeeping query; locks, registry checks,
// asset deduplication and all audit writes still use the existing helper.
const attachmentClient = { query(sql, values) {
  if (sql === 'UPDATE products SET updated_at=now() WHERE id=$1') return Promise.resolve({ rows: [], rowCount: 0 });
  return client.query(sql, values);
} };
let transaction = false;
try {
  if (args.action === 'rollback') {
    assert.match(args.operationId, /^[a-f0-9-]{36}$/);
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE'); transaction = true;
    await client.query("SET LOCAL lock_timeout='3s'");
    await client.query('LOCK TABLE products,assets,storage_files,storage_events,storage_operations IN SHARE ROW EXCLUSIVE MODE');
    const rollbackBefore = await fingerprints();
    const operation = (await client.query("SELECT * FROM storage_operations WHERE id=$1 AND kind='figure-autolink' FOR UPDATE", [args.operationId])).rows[0];
    assert.ok(operation, 'Unknown autolink operation');
    assert.ok(!operation.result.rolledBack, 'Already rolled back');
    for (const change of operation.result.changes) {
      const current = (await client.query('SELECT to_jsonb(a) AS data FROM assets a WHERE id=$1', [change.assetAfter.id])).rows[0]?.data;
      assert.equal(canonical(current), canonical(change.assetAfter), 'Attachment edited since autolink; rollback refused');
      if (change.assetBefore) await client.query('UPDATE assets SET metadata=$2,retired_at=$3 WHERE id=$1', [current.id, change.assetBefore.metadata, change.assetBefore.retired_at]);
      else await client.query('DELETE FROM assets WHERE id=$1', [current.id]);
      const currentFile = (await client.query('SELECT to_jsonb(f) AS data FROM storage_files f WHERE id=$1', [change.fileAfter.id])).rows[0]?.data;
      assert.equal(canonical(currentFile), canonical(change.fileAfter), 'Registry edited since autolink; rollback refused');
      const f = change.fileBefore;
      await client.query('UPDATE storage_files SET checked_at=$2,verified_at=$3,metadata=$4,status=$5,sha256=$6,size_bytes=$7 WHERE id=$1',
        [f.id, f.checked_at, f.verified_at, f.metadata, f.status, f.sha256, f.size_bytes]);
      const restoredFile = (await client.query('SELECT to_jsonb(f) AS data FROM storage_files f WHERE id=$1', [f.id])).rows[0].data;
      assert.equal(canonical(restoredFile), canonical(f));
      const restoredAsset = (await client.query('SELECT to_jsonb(a) AS data FROM assets a WHERE id=$1', [change.assetAfter.id])).rows[0]?.data ?? null;
      assert.equal(canonical(restoredAsset), canonical(change.assetBefore));
    }
    await client.query("UPDATE storage_operations SET result=result || jsonb_build_object('rolledBack',true,'rolledBackAt',now()),updated_at=now() WHERE id=$1", [operation.id]);
    await client.query("INSERT INTO storage_events(operation_id,action,details) VALUES($1,'figure-autolink-rollback',$2)", [operation.id, { restored: operation.result.changes.length }]);
    if (args.verifyRollbackOnly) await client.query('ROLLBACK'); else await client.query('COMMIT');
    transaction = false;
    if (args.verifyRollbackOnly) assert.deepEqual(await fingerprints(), rollbackBefore, 'Rollback dry run changed the database');
    console.log(JSON.stringify({ action: 'rollback', dryRun: !!args.verifyRollbackOnly, restored: operation.result.changes.length, passed: true }));
  } else {
    assert.equal(plan.format, 'donarium-figure-link-plan');
    const rows = plan.products.filter(row => row.status === 'ready' && (!args.sampleIds || args.sampleIds.includes(row.productId)));
    assert.ok(rows.length, 'No approved unambiguous matches');
    assert.equal(new Set(rows.map(r => r.productId)).size, rows.length);
    assert.equal(new Set(rows.map(r => r.fileId)).size, rows.length);
    // Check every source through the real guarded NFS service before locking tables.
    for (const row of rows) await checkOriginal(row);
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE'); transaction = true;
    await client.query("SET LOCAL lock_timeout='3s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['donarium-figure-autolink']);
    await client.query('LOCK TABLE products,assets,storage_files,storage_locations,storage_events,storage_operations IN SHARE ROW EXCLUSIVE MODE');
    const before = await fingerprints();
    const pending = [], already = [];
    for (const row of rows) {
      const p = (await client.query('SELECT to_jsonb(p) AS data FROM products p WHERE id=$1 FOR UPDATE', [row.productId])).rows[0]?.data;
      assert.equal(canonical(p), canonical(row.productSnapshot), `Product changed: ${row.productId}`);
      const current = (await client.query("SELECT * FROM assets WHERE product_id=$1 AND metadata->>'role'='figure' AND retired_at IS NULL", [row.productId])).rows;
      if (current.length) {
        assert.equal(current.length, 1);
        assert.equal(current[0].file_id, row.fileId, 'Existing different figure is never overwritten');
        already.push(row.productId);
      } else pending.push(row);
    }
    if (!pending.length) {
      assert.deepEqual(await fingerprints(), before);
      await client.query('ROLLBACK'); transaction = false;
      console.log(JSON.stringify({ passed: true, action: args.action, attached: 0, alreadyCorrect: already.length, databaseUnchanged: true }));
    } else {
      assert.deepEqual(before, plan.snapshotFingerprints, 'Database changed since analysis; rebuild the plan and backup');
      const operationId = randomUUID();
      const originalAssets = (await client.query('SELECT id,to_jsonb(a) AS data FROM assets a ORDER BY id')).rows;
      const originalFiles = (await client.query('SELECT id,to_jsonb(f) AS data FROM storage_files f ORDER BY id')).rows;
      await client.query("INSERT INTO storage_operations(id,kind,status,total,parameters) VALUES($1,'figure-autolink','running',$2,$3)",
        [operationId, pending.length, { planSha256: args.planSha256, algorithmVersion: plan.version, source: 'explicit-owner-request' }]);
      const eventsBefore = new Set((await client.query('SELECT id FROM storage_events')).rows.map(r => r.id));
      const changes = [];
      for (const row of pending) {
        const fileBefore = (await client.query('SELECT to_jsonb(f) AS data FROM storage_files f WHERE id=$1', [row.fileId])).rows[0]?.data;
        assert.ok(fileBefore);
        assert.equal(fileBefore.sha256, row.sha256);
        const assetBefore = (await client.query('SELECT to_jsonb(a) AS data FROM assets a WHERE product_id=$1 AND file_id=$2', [row.productId, row.fileId])).rows[0]?.data ?? null;
        await saveFigureFile(attachmentClient, service, row.productId, { root: row.root, path: row.path });
        const assetAfter = (await client.query("SELECT to_jsonb(a) AS data FROM assets a WHERE product_id=$1 AND metadata->>'role'='figure' AND retired_at IS NULL", [row.productId])).rows[0]?.data;
        assert.equal(assetAfter?.file_id, row.fileId);
        assert.equal(assetAfter?.relative_path, row.path);
        const fileAfter = (await client.query('SELECT to_jsonb(f) AS data FROM storage_files f WHERE id=$1', [row.fileId])).rows[0].data;
        changes.push({ productId: row.productId, path: row.path, assetBefore, assetAfter, fileBefore, fileAfter });
        await client.query("INSERT INTO storage_events(operation_id,file_id,product_id,action,details) VALUES($1,$2,$3,'figure-autolink',$4)",
          [operationId, row.fileId, row.productId, { assetId: assetAfter.id, path: row.path, evidence: row.evidence }]);
      }
      const after = await fingerprints();
      const currentAssets = new Map((await client.query('SELECT id,to_jsonb(a) AS data FROM assets a')).rows.map(r => [r.id,r.data]));
      for (const original of originalAssets) {
        const changed = changes.find(c => c.assetBefore?.id === original.id);
        const current = currentAssets.get(original.id);
        assert.equal(canonical(current), canonical(changed ? changed.assetAfter : original.data), `Existing attachment damaged: ${original.id}`);
      }
      const changedFileIds = new Set(changes.map(c => c.fileAfter.id));
      const currentFiles = new Map((await client.query('SELECT id,to_jsonb(f) AS data FROM storage_files f')).rows.map(r => [r.id,r.data]));
      for (const original of originalFiles) if (!changedFileIds.has(original.id)) {
        assert.equal(canonical(currentFiles.get(original.id)), canonical(original.data), `Unrelated registry file changed: ${original.id}`);
      }
      for (const table of Object.keys(before)) {
        if (!['assets', 'storage_files', 'storage_events', 'storage_operations'].includes(table)) assert.deepEqual(after[table], before[table], `Unexpected changes to ${table}`);
      }
      assert.equal(after.assets.count - before.assets.count, changes.filter(c => !c.assetBefore).length);
      assert.equal(after.storage_files.count, before.storage_files.count);
      const eventIds = (await client.query('SELECT id FROM storage_events')).rows.map(r => r.id).filter(id => !eventsBefore.has(id));
      await client.query('UPDATE storage_events SET operation_id=$1 WHERE id=ANY($2::bigint[])', [operationId, eventIds]);
      const result = { changes, before, eventIds, attached: changes.length, alreadyCorrect: already.length };
      await client.query("UPDATE storage_operations SET status='completed',progress=total,result=$2,updated_at=now() WHERE id=$1", [operationId, result]);
      if (args.action === 'rehearse') {
        // The same real candidates must resolve to the existing unique assets.
        const initialAssetIds = changes.map(c => c.assetAfter.id);
        for (const row of pending) {
          const existing = (await client.query("SELECT id,file_id FROM assets WHERE product_id=$1 AND metadata->>'role'='figure' AND retired_at IS NULL", [row.productId])).rows[0];
          assert.equal(existing.file_id, row.fileId);
          assert.ok(initialAssetIds.includes(existing.id));
        }
        await client.query('ROLLBACK'); transaction = false;
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transaction = true;
        assert.deepEqual(await fingerprints(), before, 'Rehearsal did not fully roll back');
        await client.query('ROLLBACK'); transaction = false;
        console.log(JSON.stringify({ passed: true, action: 'rehearse', sampled: pending.map(r => ({ id: r.productId, title: r.title, path: r.path })), rolledBack: true, databaseUnchanged: true }));
      } else {
        await client.query('COMMIT'); transaction = false;
        console.log(JSON.stringify({ passed: true, action: 'apply', operationId, attached: changes.length, alreadyCorrect: already.length, eventCount: eventIds.length, preservedProducts: before.products.count }));
      }
    }
  }
} catch (error) {
  if (transaction) await client.query('ROLLBACK').catch(() => undefined);
  console.error(JSON.stringify({ passed: false, action: args.action, error: error.message }));
  process.exitCode = 1;
} finally { client.release(); await pool.end(); }
