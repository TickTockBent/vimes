<script setup lang="ts">
// Segmented Auto / Light / Dark control (unit 6b·2). Styled through the new
// design-system token utilities (bg-panel / text-ink / border-line / etc.) so
// it re-themes along with everything the tokens drive — which is also the live
// proof the picker works: tapping a segment swaps the tokens and the control
// itself restyles. The pure mode list + the decision logic live in lib/theme.ts;
// the side effects (persist, data-theme) live in lib/useTheme.ts. This is view
// only, so per the house rule it carries no unit test.
import { THEME_MODES, type ThemeMode } from '../lib/theme.js';
import { useTheme } from '../lib/useTheme.js';

const { mode, setMode } = useTheme();

const SEGMENT_LABELS: Record<ThemeMode, string> = {
  auto: 'Auto',
  light: 'Light',
  dark: 'Dark',
};
</script>

<template>
  <div
    class="inline-flex items-center gap-0.5 rounded-md border border-line bg-panel-sunken p-0.5"
    role="group"
    aria-label="Theme"
  >
    <button
      v-for="themeMode in THEME_MODES"
      :key="themeMode"
      type="button"
      class="rounded px-2 py-1 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] transition-colors"
      :class="
        mode === themeMode
          ? 'bg-accent text-accent-fg'
          : 'text-ink-dim hover:text-ink'
      "
      :aria-pressed="mode === themeMode"
      @click="setMode(themeMode)"
    >
      {{ SEGMENT_LABELS[themeMode] }}
    </button>
  </div>
</template>
