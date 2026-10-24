import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('../../', import.meta.url)), '');
  const apiTarget = `http://127.0.0.1:${env.DEV_API_PORT || 4181}`;
  return {
    root: fileURLToPath(new URL('.', import.meta.url)),
    plugins: [react()],
    server: {
      host: env.HOST || '127.0.0.1',
      port: Number(env.DEV_WEB_PORT || 4180),
      strictPort: true,
      proxy: { '/api': { target: apiTarget }, '/health': { target: apiTarget } },
    },
    build: { outDir: 'dist', sourcemap: false },
  };
});
