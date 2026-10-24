import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';

const project = fileURLToPath(new URL('../', import.meta.url));
const composeArgs = ['compose', '-p', 'donarium-audit-test', '-f', join(project, 'compose.test.yml')];
const sourceUrl = 'postgresql://donarium_test@127.0.0.1:5549/donarium_test_source';
const restoreUrl = 'postgresql://donarium_test@127.0.0.1:5549/donarium_test_restore';
const environmentFile = join(tmpdir(), 'donarium-integration-env.json');
function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: project, stdio: 'inherit', env: { ...process.env, ...env } });
    child.on('error', () => reject(new Error(`Could not start ${command}`)));
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} failed (${code})`)));
  });
}

try {
  if (process.argv.includes('--down')) {
    await run('docker', [...composeArgs, 'down']);
  } else {
    await run('docker', [...composeArgs, 'up', '-d', '--wait', 'db']);
    // This connection can only address our disposable loopback fixture.
    const pool = new pg.Pool({ connectionString: sourceUrl, max: 1 });
    try {
      const found = await pool.query("SELECT 1 FROM pg_database WHERE datname='donarium_test_restore'");
      if (!found.rowCount) await pool.query('CREATE DATABASE donarium_test_restore');
    } finally { await pool.end(); }
    for (const databaseUrl of [sourceUrl, restoreUrl]) {
      await run(process.execPath, ['--import', 'tsx', 'scripts/migrate.ts'], { DATABASE_URL: databaseUrl, DB_MIGRATION_CONFIRM: 'donarium' });
    }
    const sourcePool = new pg.Pool({ connectionString: sourceUrl, max: 1 });
    try {
      const count = await sourcePool.query('SELECT count(*)::int AS count FROM products');
      if (count.rows[0].count === 0) await run(process.execPath, ['--import', 'tsx', 'scripts/seed-demo.ts'], { DATABASE_URL: sourceUrl, DB_MIGRATION_CONFIRM: 'donarium' });
    } finally { await sourcePool.end(); }
    await writeFile(environmentFile, `${JSON.stringify({ TEST_DATABASE_URL: sourceUrl, RESTORE_DATABASE_URL: restoreUrl }, null, 2)}\n`, { mode: 0o600 });
    console.log(`Isolated test URLs saved to ${environmentFile}; no credentials are used.`);
    await run('npm', ['run', 'build', '-w', '@donarium/shared']);
    const testEnv = { TEST_DATABASE_URL: sourceUrl, RESTORE_DATABASE_URL: restoreUrl };
    if (process.argv.includes('--prepare-only')) {
      await run(process.execPath, ['--import', 'tsx', 'tests/postgres.integration.test.ts'], testEnv);
      await run(process.execPath, ['--import', 'tsx', 'tests/catalog.integration.test.ts'], testEnv);
    } else {
      await run('npm', ['test'], testEnv);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Integration environment failed');
  process.exitCode = 1;
}
