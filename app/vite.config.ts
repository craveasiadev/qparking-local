import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Vite config for the renderer process (the React UI). Electron loads the
 * built bundle from dist/renderer via a file:// URL in production and from
 * http://localhost:5173 in dev. We force a relative `base` so file://
 * paths resolve correctly once packaged into the asar bundle.
 */
export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  publicDir: path.resolve(__dirname, 'src/renderer/public'),
  server: { port: 5173, strictPort: true },
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome120', // Electron 32 ships Chromium 128
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
});
