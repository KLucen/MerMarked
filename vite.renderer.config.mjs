import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  resolve: {
    // Also used by dev-server workers. Prefer DOM-free entity decoding so
    // Markdown parsing works in both the page and the packaged worker.
    conditions: ['worker', 'module', 'browser', 'development|production'],
  },
  build: {
    outDir: '../../.vite/renderer/main_window',
    emptyOutDir: true,
  },
});
