<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import SessionListView from './views/SessionListView.vue';
import StreamView from './views/StreamView.vue';
import { useVimesStore } from './stores/vimesStore.js';

const store = useVimesStore();
const hash = ref(window.location.hash);

function onHashChange(): void {
  hash.value = window.location.hash;
}

onMounted(() => {
  store.init();
  window.addEventListener('hashchange', onHashChange);
});
onUnmounted(() => {
  window.removeEventListener('hashchange', onHashChange);
});

const activeSessionId = computed<string | null>(() => {
  const match = /^#\/session\/(.+)$/.exec(hash.value);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
});

function navigateToSession(appSessionId: string): void {
  window.location.hash = `#/session/${encodeURIComponent(appSessionId)}`;
}

function navigateHome(): void {
  window.location.hash = '';
}

const bannerText = computed(() => {
  if (store.connectionStatus === 'connecting') return 'Connecting…';
  if (store.connectionStatus === 'reconnecting') return 'Reconnecting…';
  if (store.catchingUp) return 'Catching up…';
  return null;
});
</script>

<template>
  <div class="flex min-h-screen flex-col">
    <div v-if="bannerText" class="sticky top-0 z-30 bg-amber-500 px-4 py-2 text-center text-sm font-medium text-white">
      {{ bannerText }}
    </div>
    <div
      v-if="store.lastRefusal"
      class="sticky top-0 z-30 flex items-center justify-between gap-3 bg-rose-600 px-4 py-2 text-sm text-white"
    >
      <span class="truncate">{{ store.lastRefusal.reason }}</span>
      <button
        type="button"
        class="min-h-[44px] min-w-[44px] shrink-0 rounded px-3 font-semibold active:bg-rose-700"
        @click="store.dismissRefusal()"
      >
        Dismiss
      </button>
    </div>

    <StreamView v-if="activeSessionId" :app-session-id="activeSessionId" @back="navigateHome" />
    <SessionListView v-else @open="navigateToSession" />
  </div>
</template>
