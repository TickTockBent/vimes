import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

// One mobile page, built to dist/ and served by the daemon via VIMES_STATIC_DIR
// (docs/slice-1.md "UI" section). No router, no PWA plugin (slice 2).
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  build: {
    outDir: 'dist',
  },
});
