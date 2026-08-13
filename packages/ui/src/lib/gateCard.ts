import type { EventRecord } from './types.js';

// D68: hand-duplicated mirror of core's gateQuestionOptionSchema/gateQuestionSchema
// (hand-mirror kept per D87 — only payload-contract type imports are
// sanctioned; see types.ts header). An AskUserQuestion gate carries 1–4 of
// these; a real permission gate carries none.
export interface GateQuestionOption {
  label: string;
  description?: string;
}
export interface GateQuestion {
  question: string;
  header?: string;
  options: GateQuestionOption[];
  multiSelect?: boolean;
}

export interface GateCard {
  requestId: string;
  appSessionId: string;
  prompt: string;
  // Optional structured headline (daemon's real gate populates these from the
  // tool INPUT; harness/older gate_fired events omit them). When present the
  // card shows a prominent tool + target headline above the prompt.
  toolName?: string;
  target?: string;
  // D68: present ONLY on an AskUserQuestion gate. When set, the card renders the
  // question UI (radio/checkbox + Other) instead of the binary Allow/Deny.
  questions?: GateQuestion[];
  status: 'fired' | 'answering';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Tolerant shape-validate of a gate_fired's `questions` field (rule 0.7 —
// observed truth over the declared narrower payload; the daemon relays the raw
// event, so read defensively). Returns undefined for anything that isn't a
// well-formed non-empty question array, so a permission gate (no questions) and a
// malformed payload both fall back to the Allow/Deny path.
function asQuestions(value: unknown): GateQuestion[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const questions: GateQuestion[] = [];
  for (const rawQuestion of value) {
    if (!isRecord(rawQuestion) || typeof rawQuestion.question !== 'string') {
      return undefined;
    }
    if (!Array.isArray(rawQuestion.options)) {
      return undefined;
    }
    const options: GateQuestionOption[] = [];
    for (const rawOption of rawQuestion.options) {
      if (!isRecord(rawOption) || typeof rawOption.label !== 'string') {
        return undefined;
      }
      options.push({
        label: rawOption.label,
        ...(typeof rawOption.description === 'string' ? { description: rawOption.description } : {}),
      });
    }
    questions.push({
      question: rawQuestion.question,
      options,
      ...(typeof rawQuestion.header === 'string' ? { header: rawQuestion.header } : {}),
      ...(typeof rawQuestion.multiSelect === 'boolean' ? { multiSelect: rawQuestion.multiSelect } : {}),
    });
  }
  return questions;
}

// gate_fired's payload on the wire carries requestId (packages/daemon/src/
// sessionHost.ts appends {appSessionId, prompt, requestId}, and wsHub relays
// the raw EventRecord — never re-validated through core's narrower
// gateFiredPayloadSchema, so requestId survives to the client). Observed
// truth over declared truth (rule 0.7): the core payload schema only
// declares {appSessionId, prompt}.
function asGateFired(
  event: EventRecord,
): {
  appSessionId: string;
  prompt: string;
  requestId: string;
  toolName?: string;
  target?: string;
  questions?: GateQuestion[];
} | null {
  if (!isRecord(event.payload)) {
    return null;
  }
  const { appSessionId, prompt, requestId, toolName, target, questions } = event.payload;
  if (typeof appSessionId === 'string' && typeof prompt === 'string' && typeof requestId === 'string') {
    const parsedQuestions = asQuestions(questions);
    return {
      appSessionId,
      prompt,
      requestId,
      // Same optional-string read as requestId above: present only on the
      // daemon's real gate, absent (undefined) on harness/older events.
      ...(typeof toolName === 'string' ? { toolName } : {}),
      ...(typeof target === 'string' ? { target } : {}),
      // D68: present only on an AskUserQuestion gate; undefined for permission gates.
      ...(parsedQuestions !== undefined ? { questions: parsedQuestions } : {}),
    };
  }
  return null;
}

function asAttentionCleared(event: EventRecord): { appSessionId: string } | null {
  if (!isRecord(event.payload)) {
    return null;
  }
  const { appSessionId } = event.payload;
  return typeof appSessionId === 'string' ? { appSessionId } : null;
}

// Pure lifecycle reducer: fired -> (answering, once the client has sent a
// gate_response) -> cleared (removed once a matching attention_cleared
// arrives — a session has at most one active needsAttention at a time, so an
// attention_cleared for that appSessionId always resolves the showing gate).
// `answeringRequestIds` reflects gate_response calls the client has already
// sent, so buttons disable immediately rather than waiting on a round trip.
export function deriveGateCards(events: readonly EventRecord[], answeringRequestIds: ReadonlySet<string>): GateCard[] {
  const active = new Map<string, GateCard>(); // keyed by appSessionId

  for (const event of events) {
    if (event.type === 'gate_fired') {
      const fired = asGateFired(event);
      if (fired !== null) {
        active.set(fired.appSessionId, {
          requestId: fired.requestId,
          appSessionId: fired.appSessionId,
          prompt: fired.prompt,
          ...(fired.toolName !== undefined ? { toolName: fired.toolName } : {}),
          ...(fired.target !== undefined ? { target: fired.target } : {}),
          ...(fired.questions !== undefined ? { questions: fired.questions } : {}),
          status: 'fired',
        });
      }
      continue;
    }
    if (event.type === 'attention_cleared') {
      const cleared = asAttentionCleared(event);
      if (cleared !== null) {
        active.delete(cleared.appSessionId);
      }
    }
  }

  return Array.from(active.values()).map((card) =>
    answeringRequestIds.has(card.requestId) ? { ...card, status: 'answering' } : card,
  );
}
