import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
// Self-hosted IBM Plex faces (unit 6b·2). Latin subset only — the weights the
// design system uses: Mono 400/600, Sans 400/500. @fontsource ships the woff2 and
// the @font-face rules; Vite bundles the fonts as hashed assets (no external CDN,
// no data-URI). The CSS --font-mono/--font-sans stacks keep the system fallback.
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import './style.css';
// Importing the theme module applies the persisted mode's `data-theme` to <html>
// at startup (before mount), so there is no flash of the wrong theme.
import './lib/useTheme.js';

createApp(App).use(createPinia()).mount('#app');
