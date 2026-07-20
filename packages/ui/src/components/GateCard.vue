<script setup lang="ts">
// target (when present) is the structured subject of the gated tool call — a
// file path, a command, a search pattern — pulled from the SDK tool INPUT
// daemon-side (never parsed from the prompt). We headline it in monospace so a
// path can't be approved unread (smoke #4). Absent → render exactly as before.
defineProps<{ prompt: string; answering: boolean; toolName?: string; target?: string }>();
const emit = defineEmits<{ respond: [response: 'allow' | 'deny'] }>();
</script>

<template>
  <div class="my-3 max-w-full min-w-0 rounded-lg border-2 border-amber-500 bg-amber-50 p-4 dark:bg-amber-950/40">
    <div v-if="target !== undefined" class="mb-3 min-w-0">
      <span
        v-if="toolName !== undefined"
        class="mb-1 inline-block rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-amber-900 uppercase dark:bg-amber-800/70 dark:text-amber-100"
      >{{ toolName }}</span>
      <p class="min-w-0 font-mono text-sm font-semibold break-all text-amber-950 dark:text-amber-50">{{ target }}</p>
    </div>
    <p
      class="mb-3 min-w-0 break-words whitespace-pre-wrap text-amber-900 dark:text-amber-100"
      :class="target !== undefined ? 'text-xs opacity-80' : 'text-sm font-medium'"
    >{{ prompt }}</p>
    <div class="flex min-w-0 gap-3 max-[360px]:flex-col">
      <button
        type="button"
        class="min-h-[44px] min-w-0 flex-1 basis-0 rounded-md bg-emerald-600 font-semibold text-white active:bg-emerald-700 disabled:opacity-50"
        :disabled="answering"
        @click="emit('respond', 'allow')"
      >
        Allow
      </button>
      <button
        type="button"
        class="min-h-[44px] min-w-0 flex-1 basis-0 rounded-md bg-rose-600 font-semibold text-white active:bg-rose-700 disabled:opacity-50"
        :disabled="answering"
        @click="emit('respond', 'deny')"
      >
        Deny
      </button>
    </div>
  </div>
</template>
