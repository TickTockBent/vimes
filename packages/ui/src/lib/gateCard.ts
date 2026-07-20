import type { EventRecord } from './types.js';

export interface GateCard {
  requestId: string;
  appSessionId: string;
  prompt: string;
  // Optional structured headline (daemon's real gate populates these from the
  // tool INPUT; harness/older gate_fired events omit them). When present the
  // card shows a prominent tool + target headline above the prompt.
  toolName?: string;
  target?: string;
  status: 'fired' | 'answering';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// gate_fired's payload on the wire carries requestId (packages/daemon/src/
// sessionHost.ts appends {appSessionId, prompt, requestId}, and wsHub relays
// the raw EventRecord — never re-validated through core's narrower
// gateFiredPayloadSchema, so requestId survives to the client). Observed
// truth over declared truth (rule 0.7): the core payload schema only
// declares {appSessionId, prompt}.
function asGateFired(
  event: EventRecord,
): { appSessionId: string; prompt: string; requestId: string; toolName?: string; target?: string } | null {
  if (!isRecord(event.payload)) {
    return null;
  }
  const { appSessionId, prompt, requestId, toolName, target } = event.payload;
  if (typeof appSessionId === 'string' && typeof prompt === 'string' && typeof requestId === 'string') {
    return {
      appSessionId,
      prompt,
      requestId,
      // Same optional-string read as requestId above: present only on the
      // daemon's real gate, absent (undefined) on harness/older events.
      ...(typeof toolName === 'string' ? { toolName } : {}),
      ...(typeof target === 'string' ? { target } : {}),
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
