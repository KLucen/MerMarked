import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  optimizeDeps: {
    // Worker-only parser imports are discovered after the page's first scan.
    // Prebundle them up front so opening/editing a document cannot trigger an
    // optimizer reload that replaces the renderer's unsaved session state.
    include: ['unified', 'remark-parse', 'remark-gfm', 'remark-frontmatter',
      'remark-rehype', 'rehype-raw', 'rehype-sanitize', 'mdast-util-to-string', 'parse5'],
  },
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
