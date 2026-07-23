import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TranscriptTail, mapTranscriptOutputs, type TailOutput } from '@vimes/core';

// Fixture-FILE tests live daemon-side (fs is allowed here; core stays pure).
// Fixtures sit at the repo root: packages/daemon/src -> ../../../fixtures.
function readFixture(name: string): string {
  const fixtureUrl = new URL(`../../../fixtures/transcripts/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(fixtureUrl), 'utf8');
}

const APP_SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const JSONL_PATH = '/home/user/.claude/projects/encoded/synthetic.jsonl';

function pushWhole(text: string, maxLineBytes?: number): TailOutput[] {
  return new TranscriptTail(maxLineBytes).push(text);
}

function pushInChunks(text: string, chunkSize: number, maxLineBytes?: number): TailOutput[] {
  const tail = new TranscriptTail(maxLineBytes);
  const outputs: TailOutput[] = [];
  for (let offset = 0; offset < text.length; offset += chunkSize) {
    outputs.push(...tail.push(text.slice(offset, offset + chunkSize)));
  }
  return outputs;
}

describe('TranscriptTail against golden fixtures (I8)', () => {
  const fixtureNames = ['baseline.jsonl', 'rotation.jsonl', 'hostile.jsonl', 'corrections.jsonl'];

  for (const fixtureName of fixtureNames) {
    it(`${fixtureName}: 7-byte chunking yields the same outputs as one chunk`, () => {
      const text = readFixture(fixtureName);
      const whole = pushWhole(text);
      const chunked = pushInChunks(text, 7);
      expect(chunked).toEqual(whole);
    });
  }

  it('baseline.jsonl: exactly 1 rotation (initial) and 19 records', () => {
    const outputs = pushWhole(readFixture('baseline.jsonl'));
    expect(outputs.filter((o) => o.kind === 'rotation')).toHaveLength(1);
    expect(outputs.filter((o) => o.kind === 'record')).toHaveLength(19);
    expect(outputs.filter((o) => o.kind === 'quarantined')).toHaveLength(0);
  });

  it('baseline.jsonl: new 2.1.207 record types (attachment, queue-operation, '
    + 'file-history-snapshot) carry no message field, so the mapper emits no '
    + 'message/usage_block events for them — exact event-count coverage', () => {
    const outputs = pushWhole(readFixture('baseline.jsonl'));
    const records = outputs.filter(
      (o): o is Extract<TailOutput, { kind: 'record' }> => o.kind === 'record',
    );
    const newTypeRecords = records.filter((r) => {
      const json = r.json as { type?: unknown };
      return (
        json.type === 'attachment' ||
        json.type === 'queue-operation' ||
        json.type === 'file-history-snapshot'
      );
    });
    // 1 queue-operation + 2 attachment + 1 file-history-snapshot, per the fixture README.
    expect(newTypeRecords).toHaveLength(4);
    for (const record of newTypeRecords) {
      const json = record.json as { message?: unknown };
      expect(json.message).toBeUndefined();
    }

    const events = mapTranscriptOutputs(APP_SESSION_ID, outputs, JSONL_PATH);
    const messageEvents = events.filter((e) => e.type === 'message');
    const usageBlockEvents = events.filter((e) => e.type === 'usage_block');
    // 8 user + 7 assistant records still produce exactly 15 message events;
    // the 4 new record-type lines contribute none. Only the one usage-bearing
    // assistant record (line 6) produces a usage_block.
    expect(messageEvents).toHaveLength(15);
    expect(usageBlockEvents).toHaveLength(1);
  });

  it('rotation.jsonl: exactly 2 rotation outputs (initial + change)', () => {
    const outputs = pushWhole(readFixture('rotation.jsonl'));
    const rotations = outputs.filter((o) => o.kind === 'rotation');
    expect(rotations).toEqual([
      { kind: 'rotation', newClaudeSessionId: '11111111-1111-4111-8111-111111111111' },
      { kind: 'rotation', newClaudeSessionId: '22222222-2222-4222-8222-222222222222' },
    ]);
  });

  it('hostile.jsonl: exactly 3 quarantines with the expected kinds, and resumes afterward', () => {
    const outputs = pushWhole(readFixture('hostile.jsonl'));
    const quarantines = outputs.filter(
      (o): o is Extract<TailOutput, { kind: 'quarantined' }> => o.kind === 'quarantined',
    );
    expect(quarantines).toHaveLength(3);
    expect(quarantines.map((q) => q.reason)).toEqual(['malformed-json', 'malformed-json', 'oversize']);

    // Resumption: the two valid records after the storm are parsed. The last
    // output must be a record (the post-storm assistant reply), not a quarantine.
    const lastOutput = outputs[outputs.length - 1]!;
    expect(lastOutput.kind).toBe('record');
    // 6 valid records total (2 opener + alien + absurd-usage + 2 post-storm).
    expect(outputs.filter((o) => o.kind === 'record')).toHaveLength(6);
  });

  it('hostile.jsonl: identical quarantine sequence under 7-byte chunking (I8 chunk-invariant)', () => {
    const whole = pushWhole(readFixture('hostile.jsonl'));
    const chunked = pushInChunks(readFixture('hostile.jsonl'), 7);
    expect(chunked).toEqual(whole);
  });
});

// ─── slice 6 step 6a — the `queued_command` fixture ──────────────────────────
//
// ⚠ `corrections.jsonl` IS SYNTHETIC. Its SHAPE and its value populations were
// measured 2026-07-22 over 30 real transcripts / 134 `queued_command`
// attachments in the live store (docs/risk-register.md), but every prompt
// string, uuid, path and timestamp in the file is invented. **No test in this
// repo reads `~/.claude`** — real transcripts contain the operator's actual
// work, and a fixture's job is to pin a shape, not to carry someone's prose into
// version control.
describe('corrections.jsonl — the measured queued_command shape, end to end', () => {
  function correctionPayloads(): Array<{
    commandMode?: string;
    originKind?: string;
    enqueuedAt?: string;
  }> {
    const outputs = pushWhole(readFixture('corrections.jsonl'));
    return mapTranscriptOutputs(APP_SESSION_ID, outputs, JSONL_PATH)
      .filter((event) => event.type === 'correction_delivered')
      .map((event) => event.payload as { commandMode?: string; originKind?: string; enqueuedAt?: string });
  }

  it('tails to 1 rotation + 14 records with zero quarantines', () => {
    const outputs = pushWhole(readFixture('corrections.jsonl'));
    expect(outputs.filter((o) => o.kind === 'rotation')).toHaveLength(1);
    expect(outputs.filter((o) => o.kind === 'record')).toHaveLength(14);
    expect(outputs.filter((o) => o.kind === 'quarantined')).toHaveLength(0);
  });

  it('ASSERTIONS 1+2+3+4: exactly THREE corrections out of SEVEN queued_command bodies', () => {
    // The file carries NINE `attachment` records, SEVEN of which claim
    // `attachment.type === 'queued_command'`. Exactly three of those seven are
    // `commandMode: 'prompt'` and become corrections; the other four must
    // contribute NOTHING (one `task-notification`, one unknown mode, two
    // malformed bodies), as must the two attachment records whose body is not a
    // `queued_command` at all (`attachment:null` and no attachment key).
    //
    // ⚠ **THE TASK-NOTIFICATION IS THE POINT OF THE COUNT.** Measured over the
    // real corpus, `commandMode` is `'prompt'` ×72 and **`'task-notification'`
    // ×62 — ~46% of these attachments are agent task-notifications, not human
    // steers.** The earlier S1/D5 prose recorded `'prompt'` as though it were
    // the only value; the measurement corrected it. If the recognizer ever
    // dropped the `commandMode` discriminator and fired on every
    // `queued_command`, this count would be 7, not 3.
    const outputs = pushWhole(readFixture('corrections.jsonl'));
    const queuedCommandRecordCount = outputs.filter((output) => {
      if (output.kind !== 'record') {
        return false;
      }
      const attachment = (output.json as { attachment?: unknown }).attachment;
      return (
        attachment !== null &&
        typeof attachment === 'object' &&
        (attachment as { type?: unknown }).type === 'queued_command'
      );
    }).length;
    expect(queuedCommandRecordCount).toBe(7);
    expect(correctionPayloads()).toHaveLength(3);
  });

  it('ASSERTION 1: origin.kind rides as EVIDENCE, and its absence never drops a correction', () => {
    // Middle record: `prompt`, no origin, no enqueue timestamp — the 25-of-72
    // unmarked population VIMES's own SDK injections most resemble. Requiring
    // `origin.kind === 'human'` would drop it, and this expectation would fall
    // from three entries to two.
    expect(correctionPayloads()).toEqual([
      { appSessionId: APP_SESSION_ID, commandMode: 'prompt', originKind: 'human', enqueuedAt: '2026-07-13T12:00:09.000Z' },
      { appSessionId: APP_SESSION_ID, commandMode: 'prompt', originKind: undefined, enqueuedAt: undefined },
      { appSessionId: APP_SESSION_ID, commandMode: 'prompt', originKind: 'human', enqueuedAt: '2026-07-13T12:00:03.000Z' },
    ]);
  });

  it('ASSERTION 5: emitted in FILE order — the enqueue timestamps come out DESCENDING', () => {
    // ⚠ THE I6 TRAP, in a real file. The three recognized corrections sit at
    // file positions 4, 7 and 13 while carrying enqueue times 12:00:09,
    // (absent) and 12:00:03. The attachment holds the ENQUEUE time but sits at
    // the DELIVERY file position (30.4 s apart in observed run A5), and
    // attachment-vs-remove order is not even stable between runs — so FILE
    // POSITION IS THE DELIVERY TRUTH. Any sort by `timestamp`, anywhere on this
    // path, reverses the first and third entries and reddens this case.
    const enqueueTimestamps = correctionPayloads().map((payload) => payload.enqueuedAt);
    expect(enqueueTimestamps).toEqual([
      '2026-07-13T12:00:09.000Z',
      undefined,
      '2026-07-13T12:00:03.000Z',
    ]);
    const sortedAscending = [...enqueueTimestamps].sort((left, right) =>
      (left ?? '').localeCompare(right ?? ''),
    );
    expect(enqueueTimestamps).not.toEqual(sortedAscending);
  });

  it('ASSERTION 4: the malformed attachments never throw, and the file still yields its messages', () => {
    // Four malformed bodies sit mid-file (`attachment:null`, a `queued_command`
    // with no `commandMode`, one with non-string fields and a non-object
    // `origin`, and an `attachment` record with no attachment at all). None may
    // throw, and none may stop the records after them from mapping — the two
    // user/assistant turns before them and the usage-bearing assistant turn
    // after them all still produce their ordinary events.
    const outputs = pushWhole(readFixture('corrections.jsonl'));
    const events = mapTranscriptOutputs(APP_SESSION_ID, outputs, JSONL_PATH);
    expect(events.filter((event) => event.type === 'message')).toHaveLength(3);
    expect(events.filter((event) => event.type === 'usage_block')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'line_quarantined')).toHaveLength(0);
  });
});
