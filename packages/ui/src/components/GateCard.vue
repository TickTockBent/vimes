<script setup lang="ts">
// target (when present) is the structured subject of the gated tool call — a
// file path, a command, a search pattern — pulled from the SDK tool INPUT
// daemon-side (never parsed from the prompt). We headline it in monospace so a
// path can't be approved unread (smoke #4). Absent → render exactly as before.
//
// D68: `questions` (present ONLY for an AskUserQuestion gate) switches the card
// from the binary Allow/Deny gate to a first-class multi-option prompt: one block
// per question, single-select as a radio group, multiSelect as checkboxes, each
// with an "Other" free-text affordance. A permission gate has no `questions` and
// renders the existing Allow/Deny markup byte-identically.
import { reactive, computed } from 'vue';
import type { GateQuestion } from '../lib/gateCard.js';

const props = defineProps<{
  prompt: string;
  answering: boolean;
  toolName?: string;
  target?: string;
  questions?: GateQuestion[];
}>();
const emit = defineEmits<{
  respond: [response: 'allow' | 'deny' | { answers: Record<string, string> }];
}>();

// Sentinel for the "Other" radio in a single-select question (a label collision
// with a real option is impossible — real values are the option labels).
const OTHER_SENTINEL = '__vimes_other_sentinel__';

interface QuestionState {
  // single-select: the chosen option label, '' for none, or OTHER_SENTINEL.
  singleValue: string;
  // multiSelect: the chosen option labels (checkbox array binding).
  multiValues: string[];
  // multiSelect: whether the "Other" checkbox is ticked.
  otherChecked: boolean;
  // the typed free-text for this question's "Other" affordance.
  otherText: string;
}

// One state row per question. `questions` is stable for a card's lifetime (a gate
// fires once), so initializing here at setup is safe.
const state = reactive<QuestionState[]>(
  (props.questions ?? []).map(() => ({
    singleValue: '',
    multiValues: [],
    otherChecked: false,
    otherText: '',
  })),
);

// The submitted string value for one question, per the pinned encoding (D68):
// single = the chosen label (or the typed Other text); multiSelect = the chosen
// labels in OPTION ORDER, plus the Other text if given, joined with ", ".
function valueFor(questionIndex: number): string {
  const question = props.questions?.[questionIndex];
  const questionState = state[questionIndex];
  if (question === undefined || questionState === undefined) {
    return '';
  }
  if (question.multiSelect === true) {
    const chosenLabels = question.options
      .map((option) => option.label)
      .filter((label) => questionState.multiValues.includes(label));
    if (questionState.otherChecked && questionState.otherText.trim() !== '') {
      chosenLabels.push(questionState.otherText.trim());
    }
    return chosenLabels.join(', ');
  }
  if (questionState.singleValue === OTHER_SENTINEL) {
    return questionState.otherText.trim();
  }
  return questionState.singleValue;
}

// Submit is live only once EVERY question has a non-empty value — this is the
// guard against re-introducing the empty-answer bug from the UI side.
const allAnswered = computed(() =>
  (props.questions ?? []).every((_question, index) => valueFor(index) !== ''),
);

function submitAnswers(): void {
  const answers: Record<string, string> = {};
  (props.questions ?? []).forEach((question, index) => {
    answers[question.question] = valueFor(index);
  });
  emit('respond', { answers });
}
</script>

<template>
  <div class="my-3 max-w-full min-w-0 rounded-lg border-2 border-warn bg-warn/10 p-4">
    <!-- D68: AskUserQuestion — render the structured question surface. -->
    <template v-if="questions !== undefined">
      <div
        v-for="(question, questionIndex) in questions"
        :key="questionIndex"
        class="mb-4 min-w-0"
      >
        <span
          v-if="question.header !== undefined"
          class="mb-1 inline-block rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-semibold font-mono tracking-[0.08em] text-warn uppercase"
        >{{ question.header }}</span>
        <p class="mb-2 min-w-0 text-sm font-medium break-words whitespace-pre-wrap text-warn">
          {{ question.question }}
        </p>

        <!-- multiSelect → checkboxes -->
        <div v-if="question.multiSelect === true" class="flex flex-col gap-2">
          <label
            v-for="option in question.options"
            :key="option.label"
            class="flex min-h-[44px] min-w-0 items-start gap-2 rounded-md bg-warn/5 px-2 py-2"
          >
            <input
              type="checkbox"
              class="mt-0.5 h-4 w-4 shrink-0"
              :value="option.label"
              v-model="state[questionIndex]!.multiValues"
              :disabled="answering"
            />
            <span class="min-w-0 text-sm text-ink">
              <span class="font-medium break-words">{{ option.label }}</span>
              <span v-if="option.description !== undefined" class="block text-xs break-words text-ink-dim">{{ option.description }}</span>
            </span>
          </label>
          <label class="flex min-h-[44px] min-w-0 items-start gap-2 rounded-md bg-warn/5 px-2 py-2">
            <input
              type="checkbox"
              class="mt-0.5 h-4 w-4 shrink-0"
              v-model="state[questionIndex]!.otherChecked"
              :disabled="answering"
            />
            <span class="min-w-0 flex-1 text-sm text-ink">
              <span class="font-medium">Other</span>
              <input
                type="text"
                class="mt-1 block w-full min-w-0 rounded border border-line bg-ground px-2 py-1 text-sm text-ink"
                placeholder="Type your answer"
                v-model="state[questionIndex]!.otherText"
                :disabled="answering || !state[questionIndex]!.otherChecked"
              />
            </span>
          </label>
        </div>

        <!-- single-select → radio group -->
        <div v-else class="flex flex-col gap-2">
          <label
            v-for="option in question.options"
            :key="option.label"
            class="flex min-h-[44px] min-w-0 items-start gap-2 rounded-md bg-warn/5 px-2 py-2"
          >
            <input
              type="radio"
              class="mt-0.5 h-4 w-4 shrink-0"
              :value="option.label"
              v-model="state[questionIndex]!.singleValue"
              :disabled="answering"
            />
            <span class="min-w-0 text-sm text-ink">
              <span class="font-medium break-words">{{ option.label }}</span>
              <span v-if="option.description !== undefined" class="block text-xs break-words text-ink-dim">{{ option.description }}</span>
            </span>
          </label>
          <label class="flex min-h-[44px] min-w-0 items-start gap-2 rounded-md bg-warn/5 px-2 py-2">
            <input
              type="radio"
              class="mt-0.5 h-4 w-4 shrink-0"
              :value="OTHER_SENTINEL"
              v-model="state[questionIndex]!.singleValue"
              :disabled="answering"
            />
            <span class="min-w-0 flex-1 text-sm text-ink">
              <span class="font-medium">Other</span>
              <input
                type="text"
                class="mt-1 block w-full min-w-0 rounded border border-line bg-ground px-2 py-1 text-sm text-ink"
                placeholder="Type your answer"
                v-model="state[questionIndex]!.otherText"
                :disabled="answering || state[questionIndex]!.singleValue !== OTHER_SENTINEL"
              />
            </span>
          </label>
        </div>
      </div>

      <div class="flex min-w-0 gap-3 max-[360px]:flex-col">
        <button
          type="button"
          class="min-h-[44px] min-w-0 flex-1 basis-0 rounded-md bg-ok font-semibold text-accent-fg active:bg-ok/80 disabled:opacity-50"
          :disabled="answering || !allAnswered"
          @click="submitAnswers"
        >
          Submit
        </button>
        <button
          type="button"
          class="min-h-[44px] min-w-0 flex-1 basis-0 rounded-md bg-crit font-semibold text-accent-fg active:bg-crit/80 disabled:opacity-50"
          :disabled="answering"
          @click="emit('respond', 'deny')"
        >
          Decline
        </button>
      </div>
    </template>

    <!-- Real permission gate — the existing Allow/Deny surface, unchanged. -->
    <template v-else>
      <div v-if="target !== undefined" class="mb-3 min-w-0">
        <span
          v-if="toolName !== undefined"
          class="mb-1 inline-block rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-semibold font-mono tracking-[0.08em] text-warn uppercase"
        >{{ toolName }}</span>
        <p class="min-w-0 font-mono text-sm font-semibold break-all text-warn">{{ target }}</p>
      </div>
      <p
        class="mb-3 min-w-0 break-words whitespace-pre-wrap text-warn"
        :class="target !== undefined ? 'text-xs opacity-80' : 'text-sm font-medium'"
      >{{ prompt }}</p>
      <div class="flex min-w-0 gap-3 max-[360px]:flex-col">
        <button
          type="button"
          class="min-h-[44px] min-w-0 flex-1 basis-0 rounded-md bg-ok font-semibold text-accent-fg active:bg-ok/80 disabled:opacity-50"
          :disabled="answering"
          @click="emit('respond', 'allow')"
        >
          Allow
        </button>
        <button
          type="button"
          class="min-h-[44px] min-w-0 flex-1 basis-0 rounded-md bg-crit font-semibold text-accent-fg active:bg-crit/80 disabled:opacity-50"
          :disabled="answering"
          @click="emit('respond', 'deny')"
        >
          Deny
        </button>
      </div>
    </template>
  </div>
</template>
