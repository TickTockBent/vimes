import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// One mobile page, built to dist/ and served by the daemon via VIMES_STATIC_DIR.
// Slice-2 step 3 adds the PWA: a manifest + an injectManifest service worker
// (src/sw.ts) that owns web-push delivery and the notification deep-link.
export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
    VitePWA({
      // The SW auto-updates in the background; we own skipWaiting/clientsClaim in
      // src/sw.ts (injectManifest strategy — our SW, the plugin injects the
      // precache manifest at self.__WB_MANIFEST).
      registerType: 'autoUpdate',
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectRegister: 'auto',
      // Colors track the dark UI (bg-slate-950 background, sky-600 accent).
      manifest: {
        name: 'VIMES',
        short_name: 'VIMES',
        description: 'Agent-first remote IDE for Claude Code',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        theme_color: '#0284c7',
        background_color: '#020617',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      devOptions: {
        // Keep the SW out of the way during `vite dev`; it is built for prod.
        enabled: false,
      },
    }),
  ],
  build: {
    outDir: 'dist',
  },
});
