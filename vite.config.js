import { defineConfig } from 'vite';

// GitHub Pages serves the repo at /backdrop/; dev and preview use the same path.
export default defineConfig({
  base: '/backdrop/',
});
