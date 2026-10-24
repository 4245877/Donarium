import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function main() {
  const config = loadConfig();
  const app = await buildApp({ config });
  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      app.log.info({ signal }, 'Stopping DONARIUM');
      const deadline = setTimeout(() => process.exit(1), 10_000).unref();
      app.close().then(() => { clearTimeout(deadline); process.exitCode = 0; }).catch(() => { process.exitCode = 1; });
    });
  }
  try { await app.listen({ host: config.host, port: config.port }); }
  catch {
    app.log.error('Cannot start DONARIUM: check address, port and configuration');
    await app.close();
    process.exitCode = 1;
  }
}

main().catch(() => {
  console.error('DONARIUM startup failed: check environment configuration');
  process.exitCode = 1;
});
