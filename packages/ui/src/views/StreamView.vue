<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useVimesStore } from '../stores/vimesStore.js';
import { deriveGateCards } from '../lib/gateCard.js';
import { extractContentBlocks, type ContentBlockView } from '../lib/messageContent.js';
import { collapseConsecutiveUsageEvents } from '../lib/usageCollapse.js';
import { clampTextareaHeight, type TextareaMetrics } from '../lib/textareaGrow.js';
import { initialKeyboardOffsetState, reduceKeyboardOffset, type KeyboardOffsetState } from '../lib/keyboardOffset.js';
import { shouldSendSeenOnMount, shouldSendSeenOnVisibility } from '../lib/seenOnView.js';
import { cacheWarmth, deriveCacheBadge, ttlTierLabel } from '../lib/cacheBadge.js';
import { contextTokens } from '../lib/contextFill.js';
import { formatTokenCount } from '../lib/costDisplay.js';
import { meterValueLabel, usageStripModel, type MeterRow } from '../lib/meterDisplay.js';
import { deriveCorrectionStatus, formatQueuedFor } from '../lib/correctionStatus.js';
import { shouldStick } from '../lib/stickToBottom.js';
import { decideComposerEnter } from '../lib/composerKey.js';
import GateCard from '../components/GateCard.vue';
import MarkdownMessage from '../components/MarkdownMessage.vue';
import type { EventRecord } from '../lib/types.js';

// D41: this panel's close affordance. 'close' (a desktop panel) renders ✕;
// 'back' (a phone) keeps the original back affordance. The click handler is
// UNCHANGED — only the label/aria differ.
const props = defineProps<{ appSessionId: string; backKind?: 'back' | 'close' }>();
defineEmits<{ back: [] }>();

const store = useVimesStore();
const draft = ref('');
const composerRef = ref<HTMLTextAreaElement | null>(null);

// Enter-to-send (desktop) vs Enter-stays-newline (mobile/touch) — see
// decideComposerEnter in lib/composerKey.ts for the pure decision. The
// PRIMARY pointer being fine (a real mouse/trackpad) is the "has a real
// keyboard, enter-to-send is safe" signal; a phone/tablet's primary pointer is
// coarse. Pointer type is stable per session, so a one-shot read on mount is
// enough — no resize/change listener needed.
const isDesktopComposer = ref(false);

// Defect 2: auto-growing composer. 1 row min, ~5 rows max before internal
// scrolling — see packages/ui/src/lib/textareaGrow.ts for the pure clamp math.
const TEXTAREA_MIN_ROWS = 1;
const TEXTAREA_MAX_ROWS = 5;

function textareaMetrics(el: HTMLTextAreaElement): TextareaMetrics {
  const computed = window.getComputedStyle(el);
  const lineHeightPx = parseFloat(computed.lineHeight) || 20;
  const verticalChromePx =
    parseFloat(computed.paddingTop || '0') +
    parseFloat(computed.paddingBottom || '0') +
    parseFloat(computed.borderTopWidth || '0') +
    parseFloat(computed.borderBottomWidth || '0');
  return { lineHeightPx, verticalChromePx, minRows: TEXTAREA_MIN_ROWS, maxRows: TEXTAREA_MAX_ROWS };
}

function autoGrowComposer(): void {
  const el = composerRef.value;
  if (el === null) {
    return;
  }
  el.style.height = 'auto'; // collapse first so scrollHeight reflects natural content height, not the prior clamp
  const clamp = clampTextareaHeight(el.scrollHeight, textareaMetrics(el));
  el.style.height = `${clamp.heightPx}px`;
  el.style.overflowY = clamp.overflowing ? 'auto' : 'hidden';
}

// Defect 1 fallback: window.visualViewport-driven keyboard offset — see
// packages/ui/src/lib/keyboardOffset.ts for the pure reducer. index.html's
// `interactive-widget=resizes-content` handles this on Chrome Android >=108
// already (offset stays 0 there); this covers everything else.
const keyboardOffsetState = ref<KeyboardOffsetState>(initialKeyboardOffsetState);
const keyboardOffsetPx = computed(() => keyboardOffsetState.value.offsetPx);

function handleVisualViewportChange(): void {
  const visualViewport = window.visualViewport;
  if (!visualViewport) {
    return;
  }
  const wasOpen = keyboardOffsetState.value.offsetPx > 0;
  keyboardOffsetState.value = reduceKeyboardOffset(keyboardOffsetState.value, {
    type: 'visualViewportChange',
    layoutViewportHeightPx: window.innerHeight,
    visualViewportHeightPx: visualViewport.height,
    visualViewportOffsetTopPx: visualViewport.offsetTop,
  });
  const nowOpen = keyboardOffsetState.value.offsetPx > 0;
  // Keyboard just opened while the composer is focused: the stream's tail
  // (and the composer riding above the keyboard) can end up out of view —
  // pull it back to the bottom.
  if (!wasOpen && nowOpen && document.activeElement === composerRef.value) {
    window.scrollTo({ top: document.documentElement.scrollHeight });
  }
}

// D9: viewing acks the notification. Send `seen` on mount and whenever the page
// becomes visible again (a glance while hidden must not ack — see seenOnView.ts).
function handleVisibilityChange(): void {
  if (shouldSendSeenOnVisibility(document.visibilityState)) {
    store.markSeen(props.appSessionId);
  }
}

// Slice 6 step 6b: the ticking "queued for Ns" clock, same idiom as
// SessionListView's meterClockHandle — a plain 1s setInterval bumping a local
// "now" ref that only the correction-status computed reads, cleared on
// unmount so a long-lived phone PWA doesn't accumulate leaked timers across
// every session opened and closed.
const CORRECTION_CLOCK_TICK_MS = 1_000;
const correctionNowMs = ref(Date.now());
let correctionClockHandle: ReturnType<typeof setInterval> | null = null;

// ── Stick-to-bottom auto-scroll ──────────────────────────────────────────────
// The page scrolls the DOCUMENT, not an inner element: the root is
// `min-h-screen flex-col` with a sticky header/footer and a `flex-1` <main> that
// has no overflow of its own — the ONLY overflow in this view is the composer
// textarea. This is the same scroller the keyboard-offset handler already drives
// via `window.scrollTo(document.documentElement.scrollHeight)` above. So we read
// and scroll window + document.documentElement, never a child element.
//
// The whole trick — and the reason a naive "scroll on every new event" is wrong:
// `stuckToBottom` is captured from the USER'S OWN scrolling, NOT from content
// arriving. New / streaming content follows the reader to the bottom only while
// this flag is true. Once they scroll up to read history the flag flips false and
// we leave them exactly where they are. Deriving intent from the user's scroll is
// precisely what makes the "don't yank a reader back down" guarantee hold.
const NEAR_BOTTOM_THRESHOLD_PX = 64; // near-bottom UX tolerance: within 64px of the bottom still counts as "at the bottom"
const stuckToBottom = ref(true);
const streamContentRef = ref<HTMLElement | null>(null);
let streamResizeObserver: ResizeObserver | null = null;
let scrollIntentFrameHandle: number | null = null;

// Passive scroll listener → refresh the intent flag off live document geometry.
// Throttled to a single pending rAF so a fast flick doesn't recompute on every
// scroll event.
function handleWindowScroll(): void {
  if (scrollIntentFrameHandle !== null) {
    return;
  }
  scrollIntentFrameHandle = window.requestAnimationFrame(() => {
    scrollIntentFrameHandle = null;
    stuckToBottom.value = shouldStick(
      window.scrollY,
      window.innerHeight,
      document.documentElement.scrollHeight,
      NEAR_BOTTOM_THRESHOLD_PX,
    );
  });
}

// Content-changed signal (a new event, OR an existing message GROWING as it
// streams). Follow to the bottom ONLY when the reader is currently stuck there;
// otherwise do nothing (they scrolled up — leave them put). Instant scroll: no
// smooth animation, which is cheaper and never fights ongoing streaming growth.
function followBottomIfStuck(): void {
  if (!stuckToBottom.value) {
    return;
  }
  void nextTick(() => {
    window.scrollTo({ top: document.documentElement.scrollHeight });
  });
}

onMounted(() => {
  store.subscribe(props.appSessionId);
  if (shouldSendSeenOnMount()) {
    store.markSeen(props.appSessionId);
  }
  isDesktopComposer.value = window.matchMedia('(pointer: fine)').matches;
  document.addEventListener('visibilitychange', handleVisibilityChange);
  void nextTick(autoGrowComposer);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', handleVisualViewportChange);
    window.visualViewport.addEventListener('scroll', handleVisualViewportChange);
  }
  correctionClockHandle = setInterval(() => {
    correctionNowMs.value = Date.now();
  }, CORRECTION_CLOCK_TICK_MS);

  // Intent flag comes from the user's own scrolling (passive — we never
  // preventDefault the scroll).
  window.addEventListener('scroll', handleWindowScroll, { passive: true });
  // A ResizeObserver on the stream content is the PRIMARY follow signal: it fires
  // on ANY height change, so it catches a message growing mid-stream — something a
  // `watch(events.length)` (below) would miss because the array length doesn't
  // change while an existing message's text streams in. It also fires once on
  // observe, which — since `stuckToBottom` starts true — scrolls a freshly opened
  // session to its tail with no separate one-shot needed.
  if (streamContentRef.value !== null) {
    streamResizeObserver = new ResizeObserver(() => {
      followBottomIfStuck();
    });
    streamResizeObserver.observe(streamContentRef.value);
  }
});

onUnmounted(() => {
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  if (window.visualViewport) {
    window.visualViewport.removeEventListener('resize', handleVisualViewportChange);
    window.visualViewport.removeEventListener('scroll', handleVisualViewportChange);
  }
  if (correctionClockHandle !== null) {
    clearInterval(correctionClockHandle);
    correctionClockHandle = null;
  }
  // No leaked observers/listeners across the many sessions a long-lived PWA opens
  // and closes — same cleanup discipline as correctionClockHandle above.
  window.removeEventListener('scroll', handleWindowScroll);
  if (streamResizeObserver !== null) {
    streamResizeObserver.disconnect();
    streamResizeObserver = null;
  }
  if (scrollIntentFrameHandle !== null) {
    window.cancelAnimationFrame(scrollIntentFrameHandle);
    scrollIntentFrameHandle = null;
  }
});

const events = computed<EventRecord[]>(() =>
  store.eventsFor(props.appSessionId).slice().sort((a, b) => a.seq - b.seq),
);
// Belt-and-suspenders for an appended event: a length change is the unambiguous
// "new event" signal. The ResizeObserver above already covers this case (a new
// event grows the content), but the watch is cheap and makes the append path
// explicit and independent of layout timing.
watch(() => events.value.length, () => {
  followBottomIfStuck();
});
const session = computed(() => store.sessions[props.appSessionId]);
const gateCards = computed(() => deriveGateCards(events.value, store.answeringRequestIds));
const canResume = computed(
  () =>
    session.value !== undefined &&
    (session.value.liveness === 'dormant' || session.value.liveness === 'interrupted'),
);
// D10: a mirrored (external-custody) session is read-only — the composer is
// disabled and an explanatory hint stands in for the send box, so the refusal is
// never the user's first discovery of the rule.
const mirrored = computed(() => session.value?.custody === 'external');
// D9: attention badge in the header — a glance never clears it; only the explicit
// dismiss tap does (→ clear_attention).
const attention = computed(() => session.value?.needsAttention ?? null);

// Slice 6 step 6b (D5/D30): the composer's ambient "correction queued"
// status. THE PILLAR-4 CONSTRAINT lives entirely in correctionStatus.ts — this
// computed only reads its output, never invents a duration or a prediction of
// its own. `correctionQueuedForLabel` is split out (rather than narrowing
// `correctionStatus.value.kind === 'queued'` inline in the template) so the
// template never has to prove the discriminated union to the type checker.
const correctionStatus = computed(() => deriveCorrectionStatus(session.value, correctionNowMs.value));
const correctionQueuedForLabel = computed(() => {
  const status = correctionStatus.value;
  return status.kind === 'queued' ? formatQueuedFor(status.elapsedMs) : null;
});

// Slice 4 step 4 (reshaped to WARMTH in Q4): the fuller cache-observability line
// under the header — tier + observed WARMTH (the last-write age vs the tier's
// window, never a hit rate or a countdown) + raw service_tier (D24, never a
// fabricated billing-bucket label) + tokensLabel. The list-row chip is the
// required deliverable; this is the richer view for a session already open. The
// age is aged against `correctionNowMs` — the SAME 1s-ticking local clock this
// view already maintains for the correction status, injected into the pure
// cacheWarmth (rule 0.3), not a second now-source.
const cacheBadge = computed(() => deriveCacheBadge(store.cacheObservability[props.appSessionId]));
const cacheDetailLabel = computed(() => {
  const badge = cacheBadge.value;
  if (badge === null) {
    return null;
  }
  const warmth = cacheWarmth(badge.latestBlockAt, badge.ttlTier, correctionNowMs.value);
  const tierLabel = ttlTierLabel(badge.ttlTier);
  // The warmth headline shows the verdict AND its observed basis (the age), per
  // Q4 — never a bare verdict. 'none' is just the tier; 'unknown' names the gap.
  let warmthHeadline: string;
  switch (warmth.state) {
    case 'warm':
      warmthHeadline = `${tierLabel} · warm · last write ${warmth.ageLabel ?? 'just now'}`;
      break;
    case 'cold':
      warmthHeadline = `${tierLabel} · cold · last write ${warmth.ageLabel ?? 'unknown'}`;
      break;
    case 'unknown':
      warmthHeadline = `${tierLabel} · last write time unknown`;
      break;
    case 'none':
      warmthHeadline = tierLabel;
      break;
  }
  const serviceTierLabel = badge.serviceTier ?? 'unknown tier';
  return `${warmthHeadline} · ${serviceTierLabel} · ${badge.tokensLabel}`;
});

// ── Vitals strip: context + usage (siblings of the cache line above) ─────────
// The cache line above is readout 1 (warmth); these are readouts 2 and 3. Each
// degrades INDEPENDENTLY — an unobserved context never blanks the usage cell and
// vice-versa (pillar 4). Both age against the SAME `correctionNowMs` this view
// already ticks (rule 0.3 — no second now-source).

// Readout 2 — CONTEXT: the input-side tokens of the latest observed turn
// (input + cacheRead + cacheCreation), an ABSOLUTE observed count. No percent:
// VIMES has no model→context-limit table (declared truth, a ⟨Wes⟩ call with no
// consumer yet — rule 0.5). Null when no usage_block observed / a pre-field
// daemon → the cell renders "ctx —", never a fabricated 0.
const contextTokenCount = computed(() => contextTokens(store.cacheObservability[props.appSessionId]));
const contextCellLabel = computed(() =>
  contextTokenCount.value === null ? null : formatTokenCount(contextTokenCount.value),
);

// Readout 3 — USAGE: the ACCOUNT-WIDE binding meter. events.ts:78-86 — "a meter
// belongs to no session": this is the SAME meter on every open session, and the
// template labels it 'account' so it never reads as session-scoped. Built the
// SAME way SessionListView does (store snapshot → usageStripModel → binding row,
// daemon-ordered binding-first). Consumes `store.usageSnapshot` as-is (no new
// fetch — the board already polls it); aged against `correctionNowMs`. Null when
// no meter has been observed → the cell says "usage unknown", never a 0.
const usageStrip = computed(() => usageStripModel(store.usageSnapshot, correctionNowMs.value));
const bindingMeter = computed<MeterRow | null>(() => usageStrip.value.rows[0] ?? null);

function dismissAttention(): void {
  store.clearAttention(props.appSessionId);
}

function adopt(): void {
  store.adoptSession(props.appSessionId);
}

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
  void nextTick(autoGrowComposer); // collapse back to minRows now that draft is empty
}

// Vue's `.enter` modifier fires for Enter regardless of modifiers — the
// branching (send vs newline) lives in the pure decideComposerEnter, this
// just reads the live event/environment state and acts on its verdict.
function onComposerEnter(event: KeyboardEvent): void {
  const action = decideComposerEnter({
    shiftKey: event.shiftKey,
    isComposing: event.isComposing,
    isDesktop: isDesktopComposer.value,
  });
  if (action === 'send') {
    event.preventDefault(); // stop the textarea from also inserting a newline
    submitMessage(); // already empty-guards — an empty-composer Enter is a no-op, not a blank send
  }
  // 'newline': do nothing — let the textarea insert the newline naturally.
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
        :aria-label="props.backKind === 'close' ? 'Close panel' : undefined"
        @click="$emit('back')"
      >
        {{ props.backKind === 'close' ? '✕' : '←' }}
      </button>
      <span class="truncate font-medium">{{ session?.name ?? props.appSessionId.slice(0, 8) }}</span>
      <span
        v-if="mirrored"
        class="shrink-0 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-800 dark:bg-violet-900/50 dark:text-violet-200"
      >
        mirrored
      </span>
      <span class="flex-1" />
      <button
        v-if="attention"
        type="button"
        class="shrink-0 rounded-full bg-orange-100 px-3 py-1 text-xs font-semibold text-orange-800 active:bg-orange-200 dark:bg-orange-900/50 dark:text-orange-200"
        @click="dismissAttention"
      >
        {{ attention.reason }} · dismiss
      </button>
    </header>
    <p
      v-if="cacheDetailLabel !== null"
      class="truncate border-b border-slate-100 px-3 py-1 text-xs text-slate-500 dark:border-slate-900 dark:text-slate-400"
    >
      {{ cacheDetailLabel }}
    </p>

    <!-- Vitals strip (sibling of the cache line above): context + account-wide
         usage. Semi-live — the numbers update per turn and the ages tick between;
         no real-time claim. Each cell degrades independently to "unknown". -->
    <div
      class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-slate-100 px-3 py-1 text-xs text-slate-500 dark:border-slate-900 dark:text-slate-400"
    >
      <!-- Context: absolute observed input-side tokens of the latest turn. -->
      <span
        :title="contextCellLabel === null ? 'context size not yet observed' : 'input-side tokens fed to the model on the latest observed turn'"
      >
        <span class="uppercase tracking-wide text-[10px] text-slate-400 dark:text-slate-500">ctx</span>
        {{ contextCellLabel ?? '—' }}
      </span>

      <span aria-hidden="true">·</span>

      <!-- Usage: the ACCOUNT-WIDE binding meter (NOT this session's) — labelled
           'account' so it never implies session scope; it reads identically on
           every open session, which is correct. Its resetsAt countdown IS
           observed (honest), unlike the inferred cache warmth above. Burn
           rate / exhaustion render the lib's states verbatim, including its
           "cannot see / not enough data" abstain (null = unknown, never 0). -->
      <span
        class="inline-flex flex-wrap items-baseline gap-x-1.5 gap-y-0"
        :title="bindingMeter === null
          ? 'account-wide usage not observed yet'
          : `account-wide binding limit (${bindingMeter.label}) — the same across every session`"
      >
        <span class="rounded bg-slate-100 px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
          account
        </span>
        <template v-if="bindingMeter !== null">
          <span class="font-semibold">{{ meterValueLabel(bindingMeter) }}</span>
          <span aria-hidden="true">·</span>
          <span>{{ bindingMeter.resetLabel ?? 'no reset pending' }}</span>
          <span aria-hidden="true">·</span>
          <span>{{ bindingMeter.burnRateLabel }}</span>
          <span aria-hidden="true">·</span>
          <span>{{ bindingMeter.exhaustionLabel }}</span>
        </template>
        <template v-else>
          <span>usage unknown</span>
        </template>
      </span>
    </div>

    <main ref="streamContentRef" class="flex-1 space-y-2 p-3">
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
                class="max-w-[85%] min-w-0 rounded-lg px-3 py-2 text-sm"
                :class="
                  roleOf(event) === 'user'
                    ? 'bg-sky-600 text-white whitespace-pre-wrap'
                    : 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100'
                "
              >
                <!-- ASSISTANT MESSAGES ONLY get markdown rendering — a user's
                     own message renders exactly as typed (whitespace-pre-wrap
                     above), because silently restyling what the operator
                     typed would be confusing, and their own bubble is the one
                     place literal fidelity matters most. -->
                <template v-if="roleOf(event) === 'user'">{{ block.text }}</template>
                <MarkdownMessage v-else :text="block.text" :cwd="session?.cwd ?? ''" />
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
          :tool-name="activeCardFor(event)!.toolName"
          :target="activeCardFor(event)!.target"
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

    <footer
      class="keyboard-safe-footer sticky bottom-0 flex flex-col gap-2 border-t border-slate-200 bg-white p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] dark:border-slate-800 dark:bg-slate-950"
      :style="{ '--keyboard-offset': `${keyboardOffsetPx}px` }"
    >
      <div
        v-if="mirrored"
        class="flex flex-col gap-2 rounded-md bg-slate-100 p-3 text-sm text-slate-600 dark:bg-slate-900 dark:text-slate-300"
      >
        <span>This is a mirrored terminal session — read-only. Adopt it to send messages or resume.</span>
        <button
          type="button"
          class="min-h-[44px] rounded-md bg-violet-600 font-semibold text-white active:bg-violet-700"
          @click="adopt"
        >
          Adopt session
        </button>
      </div>
      <button
        v-if="!mirrored && canResume"
        type="button"
        class="min-h-[44px] rounded-md bg-amber-500 font-semibold text-white active:bg-amber-600"
        @click="resume"
      >
        Resume
      </button>
      <div
        v-if="!mirrored && correctionQueuedForLabel !== null"
        role="status"
        aria-live="polite"
        class="flex flex-col gap-0.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
      >
        <span class="font-semibold">Correction queued · {{ correctionQueuedForLabel }}</span>
        <span>It will be delivered once the current step finishes.</span>
      </div>
      <form v-if="!mirrored" class="flex min-w-0 items-end gap-2" @submit.prevent="submitMessage">
        <textarea
          ref="composerRef"
          v-model="draft"
          rows="1"
          placeholder="Message…"
          class="max-h-40 min-h-[44px] min-w-0 flex-1 resize-none overflow-y-hidden rounded-md border border-slate-300 px-3 py-2.5 text-sm leading-5 dark:border-slate-700 dark:bg-slate-900"
          @input="autoGrowComposer"
          @keydown.enter="onComposerEnter"
        />
        <button
          type="submit"
          class="min-h-[44px] min-w-[44px] shrink-0 rounded-md bg-sky-600 px-4 font-semibold text-white active:bg-sky-700 disabled:opacity-50"
          :disabled="draft.trim().length === 0"
        >
          Send
        </button>
      </form>
    </footer>
  </div>
</template>
