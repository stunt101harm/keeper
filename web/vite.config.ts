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
        // KEEPER_API lets dev target a different backend (e.g. a mock server)
        { target: process.env.KEEPER_API ?? 'http://localhost:8790', changeOrigin: true },
      ]),
    ),
  },
  build: { outDir: 'dist', sourcemap: false },
});
