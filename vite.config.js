import { defineConfig } from 'vite';

/** Optional local dev server only — deploy remains plain static files (index.html + src/). */
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
