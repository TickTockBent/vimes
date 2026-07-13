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
  const fixtureNames = ['baseline.jsonl', 'rotation.jsonl', 'hostile.jsonl'];

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
