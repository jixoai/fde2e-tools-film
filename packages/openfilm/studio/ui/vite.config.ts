import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

/* Studio's editor: built once into dist/ and served by Studio's own server (studio/server/server.mjs) */
export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwind()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      /* two faces, one build: index.html (Studio on its server) and index-web.html (pure web on
         OPFS, film.tool.fde2e.com's). Same editor code; the entry sets `window.filmWeb`. */
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        'index-web': fileURLToPath(new URL('./index-web.html', import.meta.url)),
      },
    },
  },
});
