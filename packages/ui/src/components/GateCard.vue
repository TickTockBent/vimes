<script setup lang="ts">
defineProps<{ prompt: string; answering: boolean }>();
const emit = defineEmits<{ respond: [response: 'allow' | 'deny'] }>();
</script>

<template>
  <div class="my-3 max-w-full min-w-0 rounded-lg border-2 border-amber-500 bg-amber-50 p-4 dark:bg-amber-950/40">
    <p class="mb-3 min-w-0 text-sm font-medium break-words whitespace-pre-wrap text-amber-900 dark:text-amber-100">{{ prompt }}</p>
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
