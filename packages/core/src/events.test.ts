import { describe, expect, it } from 'vitest';
import {
  HOOK_EVENT_CONSTRUCTORS,
  REGISTERED_HOOK_EVENT_NAMES,
  gateFired,
  gateFiredPayloadSchema,
  hookEventPayloadSchema,
  hookSessionStart,
  resyncMarker,
  resyncMarkerPayloadSchema,
  runtimeDriftObserved,
  runtimeDriftObservedPayloadSchema,
  sessionAdopted,
  sessionAdoptedPayloadSchema,
  sessionRenamed,
  sessionRenamedPayloadSchema,
} from './events.js';

// gate_fired's schema widened (rule 0.7) to match wire reality: the daemon's
// real SDK gate carries requestId (sessionHost.ts's handleGate), harness
// profiles do not. Both shapes must validate under the same schema.
describe('gateFired / gateFiredPayloadSchema (widened for requestId, rule 0.7)', () => {
  it('constructor + schema both accept a payload WITH requestId', () => {
    const input = gateFired({ appSessionId: 'app-1', prompt: 'approve?', requestId: 'req-1' });
    expect(input).toEqual({
      stream: 'app-1',
      type: 'gate_fired',
      payload: { appSessionId: 'app-1', prompt: 'approve?', requestId: 'req-1' },
    });
    expect(gateFiredPayloadSchema.safeParse(input.payload).success).toBe(true);
  });

  it('constructor + schema both accept a payload WITHOUT requestId (harness profiles)', () => {
    const input = gateFired({ appSessionId: 'app-1', prompt: 'approve?' });
    expect(input).toEqual({
      stream: 'app-1',
      type: 'gate_fired',
      payload: { appSessionId: 'app-1', prompt: 'approve?' },
    });
    expect(gateFiredPayloadSchema.safeParse(input.payload).success).toBe(true);
  });
});

// Slice-2 hook vocabulary (B). Loose passthrough: unknown fields tolerated; the
// constructor emits on the session's stream with the ingress-stamped appSessionId.
describe('hook ingress vocabulary (B)', () => {
  it('hookSessionStart constructs on the session stream and tolerates unknown fields', () => {
    const payload = {
      appSessionId: 'app-1',
      hook_event_name: 'SessionStart',
      session_id: 'claude-xyz',
      transcript_path: '/t/claude-xyz.jsonl',
      cwd: '/p',
      source: 'startup',
      model: 'claude-opus-4-8[1m]',
    };
    const input = hookSessionStart(payload);
    expect(input.stream).toBe('app-1');
    expect(input.type).toBe('hook_session_start');
    const parsed = hookEventPayloadSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    // passthrough keeps the alien fields verbatim
    expect(parsed.success && (parsed.data as Record<string, unknown>).model).toBe('claude-opus-4-8[1m]');
  });

  it('the five registered hook names each map to a constructor emitting the right type', () => {
    expect(REGISTERED_HOOK_EVENT_NAMES).toEqual(['SessionStart', 'Stop', 'StopFailure', 'PreToolUse', 'SessionEnd']);
    const expectedTypes: Record<string, string> = {
      SessionStart: 'hook_session_start',
      Stop: 'hook_stop',
      StopFailure: 'hook_stop_failure',
      PreToolUse: 'hook_pre_tool_use',
      SessionEnd: 'hook_session_end',
    };
    for (const name of REGISTERED_HOOK_EVENT_NAMES) {
      const input = HOOK_EVENT_CONSTRUCTORS[name]!({ appSessionId: 'app-1', hook_event_name: name });
      expect(input.type).toBe(expectedTypes[name]);
      expect(input.stream).toBe('app-1');
    }
    expect(HOOK_EVENT_CONSTRUCTORS.NotAHook).toBeUndefined();
  });
});

// Slice-2 custody vocabulary (D10). Each constructor emits on the session stream.
describe('custody vocabulary (D10)', () => {
  it('sessionAdopted constructs on the session stream with via', () => {
    const explicit = sessionAdopted({ appSessionId: 'app-1', via: 'explicit' });
    expect(explicit).toEqual({
      stream: 'app-1',
      type: 'session_adopted',
      payload: { appSessionId: 'app-1', via: 'explicit' },
    });
    expect(sessionAdoptedPayloadSchema.safeParse(explicit.payload).success).toBe(true);
    const viaResume = sessionAdopted({ appSessionId: 'app-1', via: 'resume' });
    expect(sessionAdoptedPayloadSchema.safeParse(viaResume.payload).success).toBe(true);
    // An out-of-vocabulary `via` is rejected by the schema.
    expect(sessionAdoptedPayloadSchema.safeParse({ appSessionId: 'app-1', via: 'sneaky' }).success).toBe(false);
  });

  it('sessionRenamed constructs on the session stream with the name', () => {
    const input = sessionRenamed({ appSessionId: 'app-1', name: 'dongfu build' });
    expect(input).toEqual({
      stream: 'app-1',
      type: 'session_renamed',
      payload: { appSessionId: 'app-1', name: 'dongfu build' },
    });
    expect(sessionRenamedPayloadSchema.safeParse(input.payload).success).toBe(true);
  });

  it('resyncMarker constructs on the session stream with the sanctioned reason', () => {
    const input = resyncMarker({ appSessionId: 'app-1', reason: 'pre-adoption-history' });
    expect(input).toEqual({
      stream: 'app-1',
      type: 'resync_marker',
      payload: { appSessionId: 'app-1', reason: 'pre-adoption-history' },
    });
    expect(resyncMarkerPayloadSchema.safeParse(input.payload).success).toBe(true);
    expect(resyncMarkerPayloadSchema.safeParse({ appSessionId: 'app-1', reason: 'other' }).success).toBe(false);
  });
});

describe('runtime_drift_observed (E4)', () => {
  it('is system-scoped and accepts a null expected (unpinned)', () => {
    const input = runtimeDriftObserved({ expected: null, observed: '2.1.215' });
    expect(input.stream).toBe('system');
    expect(input.type).toBe('runtime_drift_observed');
    expect(runtimeDriftObservedPayloadSchema.safeParse(input.payload).success).toBe(true);
  });
});
