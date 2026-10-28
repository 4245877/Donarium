import { defineConfig } from '@playwright/test';
const baseURL = process.env.BASE_URL || 'http://127.0.0.1:4196';
if (process.env.E2E_WRITE === 'donarium_test') {
  const url = new URL(baseURL);
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.port !== (process.env.BROWSER_TEST_PORT || '4196')) {
    throw new Error('Write scenarios require the isolated loopback browser-test-server, not production');
  }
}
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  // All files share one disposable catalogue; parallel workers corrupt each other's fixtures.
  workers: 1,
  ...(process.env.E2E_WRITE === 'donarium_test' ? { webServer: {
    command: 'node --import tsx scripts/browser-test-server.ts',
    url: baseURL,
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 10_000 },
    timeout: 30_000,
  } } : {}),
  use: {
    baseURL,
    headless: true,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined },
  },
  reporter: 'list',
});
