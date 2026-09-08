import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Note: all backend communication (HTTP + SSE) is bridged through the Wails Go
// layer (see ../../wailsjs/go/main/App and api/client.ts), so there is no Vite
// /api proxy. The dev server below only serves the React frontend when running
// inside `wails dev` or in a plain browser (plain browser has no window.go).
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 45000,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});