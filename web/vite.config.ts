import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@keeper/types': new URL('../src/types.ts', import.meta.url).pathname,
    },
  },
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      ['/api', '/health', '/metrics'].map((p) => [
        p,
        // Dev-only proxy to the local keeper server (KEEPER_API env override
        // dropped: it pulled @types/node into the production image build).
        { target: 'http://localhost:8790', changeOrigin: true },
      ]),
    ),
  },
  build: { outDir: 'dist', sourcemap: false },
});
