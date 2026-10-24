import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
const env = { ...process.env, NODE_ENV: 'development' };
const children = [];
let stopping = false;
function signalChild(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) { if (error.code !== 'ESRCH') console.error(error.message); }
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  const exits = children.map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return resolve();
    child.once('exit', resolve);
    signalChild(child, 'SIGTERM');
  }));
  const timer = setTimeout(() => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) signalChild(child, 'SIGKILL');
    process.exit(code);
  }, 5000);
  timer.unref();
  Promise.all(exits).then(() => { clearTimeout(timer); process.exitCode = code; });
}
children.push(spawn(process.execPath, ['--watch', '--import', 'tsx', 'apps/api/src/server.ts'], { detached: process.platform !== 'win32', stdio: 'inherit', env: { ...env, HOST: '127.0.0.1', PORT: env.DEV_API_PORT || '4181' } }));
children.push(spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.config.ts', '--host', env.HOST || '127.0.0.1'], { detached: process.platform !== 'win32', stdio: 'inherit', env }));
for (const child of children) {
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code || 1); });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
