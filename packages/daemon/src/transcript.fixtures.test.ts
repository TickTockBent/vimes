import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TranscriptTail, type TailOutput } from '@vimes/core';

// Fixture-FILE tests live daemon-side (fs is allowed here; core stays pure).
// Fixtures sit at the repo root: packages/daemon/src -> ../../../fixtures.
function readFixture(name: string): string {
  const fixtureUrl = new URL(`../../../fixtures/transcripts/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(fixtureUrl), 'utf8');
}

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

  it('baseline.jsonl: exactly 1 rotation (initial) and 15 records', () => {
    const outputs = pushWhole(readFixture('baseline.jsonl'));
    expect(outputs.filter((o) => o.kind === 'rotation')).toHaveLength(1);
    expect(outputs.filter((o) => o.kind === 'record')).toHaveLength(15);
    expect(outputs.filter((o) => o.kind === 'quarantined')).toHaveLength(0);
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
