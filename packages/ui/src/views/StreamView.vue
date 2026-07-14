<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useVimesStore } from '../stores/vimesStore.js';
import { deriveGateCards } from '../lib/gateCard.js';
import { extractContentBlocks, type ContentBlockView } from '../lib/messageContent.js';
import { collapseConsecutiveUsageEvents } from '../lib/usageCollapse.js';
import GateCard from '../components/GateCard.vue';
import type { EventRecord } from '../lib/types.js';

const props = defineProps<{ appSessionId: string }>();
defineEmits<{ back: [] }>();

const store = useVimesStore();
const draft = ref('');

onMounted(() => {
  store.subscribe(props.appSessionId);
});

const events = computed<EventRecord[]>(() =>
  store.eventsFor(props.appSessionId).slice().sort((a, b) => a.seq - b.seq),
);
const session = computed(() => store.sessions[props.appSessionId]);
const gateCards = computed(() => deriveGateCards(events.value, store.answeringRequestIds));
const canResume = computed(
  () =>
    session.value !== undefined &&
    (session.value.liveness === 'dormant' || session.value.liveness === 'interrupted'),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requestIdOf(event: EventRecord): string | null {
  return isRecord(event.payload) && typeof event.payload.requestId === 'string' ? event.payload.requestId : null;
}

function activeCardFor(event: EventRecord) {
  const requestId = requestIdOf(event);
  return requestId === null ? undefined : gateCards.value.find((card) => card.requestId === requestId);
}

function roleOf(event: EventRecord): string {
  return isRecord(event.payload) && typeof event.payload.role === 'string' ? event.payload.role : 'unknown';
}

function contentBlocksOf(event: EventRecord): ContentBlockView[] {
  return isRecord(event.payload) ? extractContentBlocks(event.payload.content) : [];
}

function usageSummary(event: EventRecord): string {
  const usage = isRecord(event.payload) ? event.payload.usage : undefined;
  if (isRecord(usage)) {
    const numericEntries = Object.entries(usage)
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
      .slice(0, 4);
    if (numericEntries.length > 0) {
      return numericEntries.map(([key, value]) => `${key}: ${value}`).join(' · ');
    }
  }
  return 'usage updated';
}

// D17 (docs/open-questions.md): a turn emits one usage_block per SDK
// assistant message, so identical snapshots repeat within a turn. Every
// event still lands in the store untouched (rule 0.7) — this is a
// presentation-only filter deciding which usage_block events get a
// rendered line.
const visibleUsageEventIds = computed(() => new Set(collapseConsecutiveUsageEvents(events.value).map((event) => event.eventId)));

// tool_result previews are collapsed by default; tapping one reveals it.
// Keyed by `${eventId}:${blockIndex}` since one message event can carry
// more than one tool_result block.
const expandedToolResults = reactive(new Set<string>());

function toolResultKey(event: EventRecord, blockIndex: number): string {
  return `${event.eventId}:${blockIndex}`;
}

function isToolResultExpanded(event: EventRecord, blockIndex: number): boolean {
  return expandedToolResults.has(toolResultKey(event, blockIndex));
}

function toggleToolResult(event: EventRecord, blockIndex: number): void {
  const key = toolResultKey(event, blockIndex);
  if (expandedToolResults.has(key)) {
    expandedToolResults.delete(key);
  } else {
    expandedToolResults.add(key);
  }
}

function submitMessage(): void {
  const text = draft.value.trim();
  if (text.length === 0) {
    return;
  }
  store.sendMessage(props.appSessionId, text);
  draft.value = '';
}

function respond(card: { appSessionId: string; requestId: string }, response: 'allow' | 'deny'): void {
  store.answerGate(card.appSessionId, card.requestId, response);
}

function resume(): void {
  store.resumeSession(props.appSessionId);
}
</script>

<template>
  <div class="mx-auto flex min-h-screen max-w-lg flex-col">
    <header class="sticky top-0 z-10 flex min-h-[44px] items-center gap-2 border-b border-slate-200 bg-white/95 px-3 py-2 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95">
      <button
        type="button"
        class="min-h-[44px] min-w-[44px] rounded-md text-lg active:bg-slate-100 dark:active:bg-slate-900"
        @click="$emit('back')"
      >
        ←
      </button>
      <span class="truncate font-medium">{{ session?.name ?? props.appSessionId.slice(0, 8) }}</span>
    </header>

    <main class="flex-1 space-y-2 p-3">
      <template v-for="event in events" :key="event.eventId">
        <template v-if="event.type === 'message'">
          <template v-for="(block, blockIndex) in contentBlocksOf(event)" :key="`${event.eventId}-${blockIndex}`">
            <p
              v-if="block.kind === 'thinking'"
              class="text-center text-xs italic text-slate-400 dark:text-slate-500"
            >
              · thinking ·
            </p>

            <p
              v-else-if="block.kind === 'tool'"
              class="truncate text-center font-mono text-xs text-slate-400 dark:text-slate-500"
            >
              ⚙ {{ block.name }} {{ block.inputPreview }}
            </p>

            <div v-else-if="block.kind === 'toolResult'" class="text-center text-xs text-slate-400 dark:text-slate-500">
              <button
                v-if="!isToolResultExpanded(event, blockIndex)"
                type="button"
                class="underline decoration-dotted"
                @click="toggleToolResult(event, blockIndex)"
              >
                ↳ result (tap to expand)
              </button>
              <button
                v-else
                type="button"
                class="whitespace-pre-wrap text-left underline decoration-dotted"
                @click="toggleToolResult(event, blockIndex)"
              >
                ↳ {{ block.preview }}
              </button>
            </div>

            <div v-else-if="block.kind === 'text'" class="flex" :class="roleOf(event) === 'user' ? 'justify-end' : 'justify-start'">
              <div
                class="max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap"
                :class="
                  roleOf(event) === 'user'
                    ? 'bg-sky-600 text-white'
                    : 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100'
                "
              >
                {{ block.text }}
              </div>
            </div>
          </template>
        </template>

        <p
          v-else-if="event.type === 'usage_block' && visibleUsageEventIds.has(event.eventId)"
          class="text-center text-xs text-slate-400 dark:text-slate-500"
        >
          {{ usageSummary(event) }}
        </p>

        <GateCard
          v-else-if="event.type === 'gate_fired' && activeCardFor(event)"
          :prompt="activeCardFor(event)!.prompt"
          :answering="activeCardFor(event)!.status === 'answering'"
          @respond="(response) => respond(activeCardFor(event)!, response)"
        />

        <div v-else-if="event.type === 'run_completed'" class="my-2 flex items-center gap-2 text-xs text-slate-400 dark:text-slate-500">
          <span class="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
          run completed
          <span class="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
        </div>
      </template>
    </main>

    <footer class="sticky bottom-0 flex flex-col gap-2 border-t border-slate-200 bg-white p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] dark:border-slate-800 dark:bg-slate-950">
      <button
        v-if="canResume"
        type="button"
        class="min-h-[44px] rounded-md bg-amber-500 font-semibold text-white active:bg-amber-600"
        @click="resume"
      >
        Resume
      </button>
      <form class="flex gap-2" @submit.prevent="submitMessage">
        <input
          v-model="draft"
          type="text"
          placeholder="Message…"
          class="min-h-[44px] flex-1 rounded-md border border-slate-300 px-3 text-sm dark:border-slate-700 dark:bg-slate-900"
        />
        <button
          type="submit"
          class="min-h-[44px] min-w-[44px] rounded-md bg-sky-600 px-4 font-semibold text-white active:bg-sky-700 disabled:opacity-50"
          :disabled="draft.trim().length === 0"
        >
          Send
        </button>
      </form>
    </footer>
  </div>
</template>
