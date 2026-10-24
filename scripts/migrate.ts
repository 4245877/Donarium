import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { databaseForMaintenance, reportMaintenanceError } from './database-cli.js';

async function migrate(): Promise<void> {
  const pool = databaseForMaintenance();
  try {
    const client = await pool.connect();
    try {
      // The session lock serializes migration runners, including the initial tracking-table creation.
      await client.query("SELECT pg_advisory_lock(hashtext('donarium_schema_migrations'))");
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      const directory = fileURLToPath(new URL('../db/migrations/', import.meta.url));
      const names = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
      for (const name of names) {
        const sql = await readFile(`${directory}/${name}`, 'utf8');
        const checksum = createHash('sha256').update(sql).digest('hex');
        const applied = await client.query<{ sha256: string }>('SELECT sha256 FROM schema_migrations WHERE name = $1', [name]);
        if (applied.rows[0]) {
          if (applied.rows[0].sha256 !== checksum) throw new Error(`Migration ${name} was modified after application; add a new migration instead.`);
          console.log(`Already applied: ${name}`);
          continue;
        }
        if (name === '002_library.sql') {
          // Existing duplicate links are owner data. Stop for review rather than silently deleting them.
          const duplicates = await client.query<{ groups: string }>(`SELECT count(*)::text AS groups FROM (
            SELECT 1 FROM assets WHERE storage_id IS NOT NULL
            GROUP BY product_id, storage_id, relative_path HAVING count(*) > 1
          ) AS duplicate_links`);
          if (Number(duplicates.rows[0]?.groups ?? 0) > 0) {
            throw new Error(`Migration ${name} requires review of ${duplicates.rows[0]!.groups} duplicate asset-link groups. No links were removed. See docs/BACKUP.md before retrying.`);
          }
        }
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)', [name, checksum]);
          await client.query('COMMIT');
          console.log(`Applied: ${name}`);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
    } finally {
      // Releasing the connection also releases the advisory lock if an error prevented explicit unlock.
      await client.query("SELECT pg_advisory_unlock(hashtext('donarium_schema_migrations'))").catch(() => undefined);
      client.release();
    }
  } finally {
    await pool.end();
  }
}

await migrate().catch(reportMaintenanceError);
