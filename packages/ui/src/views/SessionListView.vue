<script setup lang="ts">
import { computed, ref } from 'vue';
import { useVimesStore } from '../stores/vimesStore.js';
import { deriveSessionRow } from '../lib/sessionRow.js';

const emit = defineEmits<{ open: [appSessionId: string] }>();
const store = useVimesStore();

const LAST_CWD_KEY = 'vimes:lastCwd';
const cwd = ref(localStorage.getItem(LAST_CWD_KEY) ?? '');
const channel = ref<'sdk' | 'pty'>('sdk');
const spawning = ref(false);

const rows = computed(() =>
  Object.values(store.sessions)
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .map(deriveSessionRow),
);

function spawn(): void {
  const trimmedCwd = cwd.value.trim();
  if (trimmedCwd.length === 0 || spawning.value) {
    return;
  }
  localStorage.setItem(LAST_CWD_KEY, trimmedCwd);
  spawning.value = true;
  store.spawnSession(channel.value, trimmedCwd, (appSessionId) => {
    spawning.value = false;
    emit('open', appSessionId);
  });
}
</script>

<template>
  <div class="mx-auto flex max-w-lg flex-col gap-4 p-4">
    <h1 class="text-lg font-semibold">Sessions</h1>

    <ul class="flex flex-col gap-2">
      <li v-for="row in rows" :key="row.appSessionId">
        <button
          type="button"
          class="flex min-h-[44px] w-full flex-col gap-1 rounded-lg border border-slate-200 p-3 text-left active:bg-slate-100 dark:border-slate-800 dark:active:bg-slate-900"
          @click="emit('open', row.appSessionId)"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="truncate font-medium">{{ row.label }}</span>
            <span class="shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold" :class="row.livenessColorClass">
              {{ row.livenessLabel }}
            </span>
          </div>
          <div class="flex items-center justify-between gap-2 text-sm text-slate-500 dark:text-slate-400">
            <span class="truncate">{{ row.channel }} · {{ row.cwdTail }}</span>
            <span
              v-if="row.attention.visible"
              class="shrink-0 rounded-full bg-orange-100 px-2 py-0.5 text-xs font-semibold text-orange-800 dark:bg-orange-900/50 dark:text-orange-200"
            >
              {{ row.attention.label }}
            </span>
          </div>
        </button>
      </li>
      <li v-if="rows.length === 0" class="p-3 text-center text-sm text-slate-500 dark:text-slate-400">
        No sessions yet — spawn one below.
      </li>
    </ul>

    <form class="flex flex-col gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800" @submit.prevent="spawn">
      <label class="text-sm font-medium" for="new-session-cwd">New session · cwd</label>
      <input
        id="new-session-cwd"
        v-model="cwd"
        type="text"
        placeholder="/home/wes/projects/games/dongfu"
        class="min-h-[44px] rounded-md border border-slate-300 px-3 text-sm dark:border-slate-700 dark:bg-slate-900"
      />
      <div class="flex items-center gap-4 text-sm">
        <label class="flex items-center gap-1">
          <input v-model="channel" type="radio" value="sdk" />
          SDK
        </label>
        <label class="flex items-center gap-1">
          <input v-model="channel" type="radio" value="pty" />
          PTY
        </label>
      </div>
      <button
        type="submit"
        class="min-h-[44px] rounded-md bg-sky-600 font-semibold text-white active:bg-sky-700 disabled:opacity-50"
        :disabled="spawning || cwd.trim().length === 0"
      >
        {{ spawning ? 'Spawning…' : 'Spawn session' }}
      </button>
    </form>
  </div>
</template>
