import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, type CorrectionDeliveredPayload } from '../events.js';
import type { EventInput } from '../schemas.js';
import { mapTranscriptOutputs } from './mapper.js';
import type { TailOutput } from './tail.js';

// ─── slice 6 step 6a — the `queued_command` recognizer ───────────────────────
//
// ⚠ EVERY record in this file is HAND-WRITTEN AND SYNTHETIC. Nothing here reads
// `~/.claude`, opens a file, or copies prose out of a real transcript. What is
// borrowed from the live store is the SHAPE and the POPULATIONS, measured
// 2026-07-22 over 30 transcripts / 134 `queued_command` attachments
// (docs/risk-register.md) — the prompt strings, uuids and timestamps are invented.
//
// The measurement that these cases exist to defend:
//
//     commandMode: 'prompt' ×72  |  'task-notification' ×62   (~46%!)
//     origin.kind: task-notification → absent 62/62
//                  prompt           → 'human' ×47, ABSENT ×25
//     attachment.timestamp (enqueue): ABSENT in 27/134 (~20%)

const APP_SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const JSONL_PATH = '/home/user/project/.synthetic/transcript.jsonl';

function record(json: unknown): TailOutput {
  return { kind: 'record', json };
}

function map(outputs: TailOutput[]): EventInput[] {
  return mapTranscriptOutputs(APP_SESSION_ID, outputs, JSONL_PATH);
}

// A `queued_command` attachment record with the surrounding envelope fields the
// real shape carries, so the recognizer is exercised against a whole record and
// not a bare attachment.
function queuedCommandRecord(attachment: unknown, envelope: Record<string, unknown> = {}): TailOutput {
  return record({
    parentUuid: 'aaaaaaaa-0000-4000-8000-0000000000ff',
    isSidechain: false,
    type: 'attachment',
    attachment,
    uuid: 'cccccccc-0000-4000-8000-0000000000ff',
    timestamp: '2026-07-13T12:00:00.000Z',
    userType: 'external',
    entrypoint: 'cli',
    cwd: '/home/user/project',
    sessionId: '33333333-3333-4333-8333-333333333333',
    version: '2.1.207',
    gitBranch: 'main',
    ...envelope,
  });
}

function correctionsIn(events: EventInput[]): CorrectionDeliveredPayload[] {
  return events
    .filter((event) => event.type === EVENT_TYPES.correctionDelivered)
    .map((event) => event.payload as CorrectionDeliveredPayload);
}

describe('mapper — a delivered correction becomes an evented fact (assertion 1)', () => {
  it('a prompt WITH origin.kind:human and an enqueue timestamp carries both as evidence', () => {
    const events = map([
      queuedCommandRecord({
        type: 'queued_command',
        prompt: 'synthetic steer',
        commandMode: 'prompt',
        timestamp: '2026-07-13T12:00:09.000Z',
        origin: { kind: 'human' },
        source_uuid: 'aaaaaaaa-0000-4000-8000-0000000000ff',
      }),
    ]);
    expect(events).toEqual([
      {
        stream: APP_SESSION_ID,
        type: EVENT_TYPES.correctionDelivered,
        payload: {
          appSessionId: APP_SESSION_ID,
          commandMode: 'prompt',
          originKind: 'human',
          enqueuedAt: '2026-07-13T12:00:09.000Z',
        },
      },
    ]);
  });

  it('a prompt with NO origin and NO timestamp is STILL a correction — the 25/72 population', () => {
    // ⚠ THE FILTER THAT MUST NEVER EXIST. 25 of the 72 observed `prompt`
    // records carry no `origin` at all, and that unmarked population is the one
    // VIMES's OWN SDK injections most resemble. Requiring
    // `origin.kind === 'human'` would silently discard our own corrections —
    // so `originKind` is evidence, never a discriminator. Break the recognizer
    // by requiring origin and this case reddens.
    const corrections = correctionsIn(
      map([
        queuedCommandRecord({
          type: 'queued_command',
          prompt: 'synthetic unmarked steer',
          commandMode: 'prompt',
        }),
      ]),
    );
    expect(corrections).toEqual([
      { appSessionId: APP_SESSION_ID, commandMode: 'prompt', originKind: undefined, enqueuedAt: undefined },
    ]);
  });

  it('the queued_command record emits NO message and NO usage_block of its own', () => {
    // It has no `message` field, so the ordinary path must still produce
    // nothing for it — the correction event is an ADDITION, not a replacement.
    const events = map([
      queuedCommandRecord({ type: 'queued_command', prompt: 'synthetic', commandMode: 'prompt' }),
    ]);
    expect(events.filter((event) => event.type === EVENT_TYPES.message)).toEqual([]);
    expect(events.filter((event) => event.type === EVENT_TYPES.usageBlock)).toEqual([]);
  });
});

describe('mapper — a task-notification is NOT a correction (assertion 2)', () => {
  it('emits NOTHING AT ALL for commandMode:"task-notification"', () => {
    // ⚠ THE ~46% FALSE-POSITIVE POPULATION. Measured 2026-07-22 over 30 real
    // transcripts / 134 `queued_command` attachments: `prompt` ×72 versus
    // **`task-notification` ×62**. The earlier S1/D5 prose recorded 'prompt' as
    // if it were the only value `commandMode` could take; the measurement
    // corrected it. A recognizer that treated every `queued_command` as a
    // correction would false-positive on nearly HALF of them, and every false
    // correction event makes the watchdog protect a run nobody is steering.
    //
    // The assertion is on the WHOLE event list, not on a filtered view: this
    // record must produce no correction event, no message, no usage_block,
    // nothing.
    const events = map([
      queuedCommandRecord({
        type: 'queued_command',
        prompt: 'synthetic agent task notification',
        commandMode: 'task-notification',
        timestamp: '2026-07-13T12:00:05.500Z',
        source_uuid: 'aaaaaaaa-0000-4000-8000-0000000000ff',
      }),
    ]);
    expect(events).toEqual([]);
  });

  it('a task-notification that ALSO carries origin.kind:human is still not a correction', () => {
    // The discriminator is `commandMode`, full stop. `origin` never promotes a
    // record — observed origin was absent in 62/62 task-notifications, but the
    // recognizer must not depend on that holding after a CLI bump.
    expect(
      map([
        queuedCommandRecord({
          type: 'queued_command',
          prompt: 'synthetic',
          commandMode: 'task-notification',
          origin: { kind: 'human' },
        }),
      ]),
    ).toEqual([]);
  });
});

describe('mapper — an unknown commandMode emits nothing and never throws (assertion 3)', () => {
  it('a third mode a future CLI might introduce is ignored for delivery', () => {
    // Rule 0.6: `commandMode` is a fragile external vocabulary. A value outside
    // the measured two is NOT guessed into a correction — it is simply not one.
    expect(
      map([
        queuedCommandRecord({
          type: 'queued_command',
          prompt: 'synthetic',
          commandMode: 'synthetic-unknown-mode',
          timestamp: '2026-07-13T12:00:07.000Z',
          origin: { kind: 'human' },
        }),
      ]),
    ).toEqual([]);
  });

  it('does not throw for any of a spread of alien commandMode values', () => {
    for (const alienMode of [null, 7, true, [], {}, '', 'PROMPT', 'prompt ']) {
      expect(() =>
        map([queuedCommandRecord({ type: 'queued_command', commandMode: alienMode })]),
      ).not.toThrow();
      expect(
        map([queuedCommandRecord({ type: 'queued_command', commandMode: alienMode })]),
      ).toEqual([]);
    }
  });
});

describe('mapper — malformed and partial attachments are no-ops, never exceptions (I8, assertion 4)', () => {
  const hostileAttachments: Array<[string, unknown]> = [
    ['null attachment', null],
    ['attachment is a string', 'queued_command'],
    ['attachment is an array', [{ type: 'queued_command', commandMode: 'prompt' }]],
    ['attachment is a number', 42],
    ['no attachment.type', { commandMode: 'prompt', prompt: 'synthetic' }],
    ['a different attachment subtype', { type: 'skill_listing', commandMode: 'prompt' }],
    ['queued_command with no commandMode', { type: 'queued_command', prompt: 'synthetic' }],
    ['queued_command with non-string fields', { type: 'queued_command', prompt: 7, commandMode: 7, timestamp: 7 }],
  ];

  for (const [label, attachment] of hostileAttachments) {
    it(`${label}: no event, no throw`, () => {
      expect(() => map([queuedCommandRecord(attachment)])).not.toThrow();
      expect(map([queuedCommandRecord(attachment)])).toEqual([]);
    });
  }

  it('an attachment record with no attachment key at all is a no-op', () => {
    expect(map([record({ type: 'attachment', uuid: 'c-1', timestamp: '2026-07-13T12:00:00.000Z' })])).toEqual([]);
  });

  it('a prompt whose origin is present but NOT an object still yields the correction, without originKind', () => {
    // The origin is evidence. A corrupt one costs the evidence, never the event
    // — dropping the correction because its origin was unreadable is exactly
    // the direction that switches the watchdog's protection off.
    expect(
      correctionsIn(
        map([
          queuedCommandRecord({
            type: 'queued_command',
            commandMode: 'prompt',
            origin: 'not-an-object',
            timestamp: '2026-07-13T12:00:09.000Z',
          }),
        ]),
      ),
    ).toEqual([
      {
        appSessionId: APP_SESSION_ID,
        commandMode: 'prompt',
        originKind: undefined,
        enqueuedAt: '2026-07-13T12:00:09.000Z',
      },
    ]);
  });

  it('a prompt whose origin object has a non-string kind yields the correction without originKind', () => {
    expect(
      correctionsIn(
        map([
          queuedCommandRecord({ type: 'queued_command', commandMode: 'prompt', origin: { kind: 7 } }),
        ]),
      ),
    ).toEqual([{ appSessionId: APP_SESSION_ID, commandMode: 'prompt', originKind: undefined, enqueuedAt: undefined }]);
  });

  it('a non-object record and a null record are still dropped (pre-existing totality)', () => {
    expect(map([record(null), record('a string'), record(7)])).toEqual([]);
  });
});

describe('mapper — records are emitted in READ order, never sorted (assertion 5)', () => {
  it('the enqueue timestamps come out in FILE order, not in timestamp order', () => {
    // ⚠ **THE I6 TRAP.** The attachment carries the ENQUEUE time but sits at the
    // DELIVERY file position, and the two were 30.4 s apart in observed run A5;
    // attachment-vs-remove order is not even stable between runs. FILE POSITION
    // IS THE DELIVERY TRUTH. These three records are laid out with enqueue times
    // deliberately DESCENDING against file order, so any sort by `timestamp`
    // reverses the first and third and this case reddens.
    const corrections = correctionsIn(
      map([
        queuedCommandRecord(
          { type: 'queued_command', commandMode: 'prompt', timestamp: '2026-07-13T12:00:09.000Z' },
          { timestamp: '2026-07-13T12:00:04.000Z' },
        ),
        queuedCommandRecord(
          { type: 'queued_command', commandMode: 'prompt' },
          { timestamp: '2026-07-13T12:00:06.000Z' },
        ),
        queuedCommandRecord(
          { type: 'queued_command', commandMode: 'prompt', timestamp: '2026-07-13T12:00:03.000Z' },
          { timestamp: '2026-07-13T12:00:11.000Z' },
        ),
      ]),
    );
    expect(corrections.map((correction) => correction.enqueuedAt)).toEqual([
      '2026-07-13T12:00:09.000Z',
      undefined,
      '2026-07-13T12:00:03.000Z',
    ]);
    // Stated the other way round so the intent survives an edit: the output must
    // NOT be what sorting by enqueue time would produce.
    const sortedByEnqueue = [...corrections].sort((left, right) =>
      (left.enqueuedAt ?? '').localeCompare(right.enqueuedAt ?? ''),
    );
    expect(corrections.map((c) => c.enqueuedAt)).not.toEqual(
      sortedByEnqueue.map((c) => c.enqueuedAt),
    );
  });

  it('corrections interleave with messages in strict read order', () => {
    const events = map([
      { kind: 'rotation', newClaudeSessionId: '33333333-3333-4333-8333-333333333333' },
      record({ type: 'user', message: { role: 'user', content: 'synthetic opening turn' } }),
      queuedCommandRecord({ type: 'queued_command', commandMode: 'prompt' }),
      record({ type: 'assistant', message: { role: 'assistant', content: 'synthetic reply', usage: { input_tokens: 1 } } }),
      queuedCommandRecord({ type: 'queued_command', commandMode: 'task-notification' }),
      queuedCommandRecord({ type: 'queued_command', commandMode: 'prompt' }),
    ]);
    expect(events.map((event) => event.type)).toEqual([
      EVENT_TYPES.claudeSessionMapped,
      EVENT_TYPES.message,
      EVENT_TYPES.correctionDelivered,
      EVENT_TYPES.message,
      EVENT_TYPES.usageBlock,
      // the task-notification contributes nothing here
      EVENT_TYPES.correctionDelivered,
    ]);
  });
});
