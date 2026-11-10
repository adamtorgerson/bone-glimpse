import { defineConfig } from 'vite';

// Cross-origin isolation enables SharedArrayBuffer, which onnxruntime-web
// needs for multi-threaded WASM inference.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  // Relative asset paths so the packed .ehpk works wherever the Even app serves it.
  base: './',
  // Listen on the LAN so the phone (Even app) can load the dev server via QR code.
  // Fixed port (another G2 project commonly sits on Vite's default 5173).
  server: { headers: isolation, host: true, port: 5180, strictPort: true },
  preview: { headers: isolation },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  build: { target: 'es2022' },
});
