// The moved-vocabulary grep gate, as a test (docs/slice-18.md §3.4, §4-A3).
//
// §3.4's law: `composeStageInstruction`, `StageInstructionContext`,
// `createTaskToolPayloadSchema`, and `CreateTaskToolPayload` moved to
// `@vimes/ext-tasks` in S18·U2. `packages/core/src` owns none of them any
// longer as live code. The ONLY vocabulary allowed to remain as CODE-SHAPE
// (declarations/references/imports) in `packages/core/src` after the split
// is §3.4's enumerated exemption list c1-c5 — five DIFFERENT names/anchors
// that stay behind as named compatibility, each with its own death trigger.
// c1-c5 are not a license to keep the four MOVED names around; they name
// what else survives. An exemption is added here only through a signed
// slice-doc change (§3.4) — never quietly, never mid-build.
//
// ⚠ **AMENDED per S18-F1 (found by this file's own original "zero
// occurrences, comments count, no exemption" test; RULED ⟨Wes⟩ 2026-08-25,
// docs/slice-18.md §5b, option (c)):** that letter collided with truthful
// doc — the barrel's own "GONE FROM THIS BARREL" tombstone, the
// `createTaskToolPayloadSchema` positional stub §3.4 itself signs, and
// c3's boundary comment in `sessionIdentity.ts`. Comments still count as
// hits — nothing here exempts a bare mention — but a SECOND, NAMED list
// (`ALLOWED_HITS`, per-file, per-identifier, each with its reason) now
// joins c1-c5: every hit not covered by it fails, and every entry that no
// longer matches a real hit (a stale listing) fails too. Same S14-F1
// doctrine as the rest of the slice — exemption lists beat blanket bans;
// each site earns its listing by its own fact and context, not by a
// sweeping rule that can't tell a tombstone from a live violation.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);
const CORE_SRC = path.resolve(path.dirname(THIS_FILE));

function walkTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

const MOVED_IDENTIFIERS = [
  'composeStageInstruction',
  'StageInstructionContext',
  'createTaskToolPayloadSchema',
  'CreateTaskToolPayload',
] as const;

interface Hit {
  file: string;
  line: number;
  identifier: string;
  text: string;
}

function findMovedVocabularyHits(): Hit[] {
  const hits: Hit[] = [];
  const files = walkTsFiles(CORE_SRC).filter((f) => path.resolve(f) !== path.resolve(THIS_FILE));
  for (const file of files) {
    const rel = path.relative(CORE_SRC, file).split(path.sep).join('/');
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    for (const identifier of MOVED_IDENTIFIERS) {
      const re = new RegExp(`\\b${identifier}\\b`);
      lines.forEach((lineText, idx) => {
        if (re.test(lineText)) {
          hits.push({ file: rel, line: idx + 1, identifier, text: lineText.trim() });
        }
      });
    }
  }
  return hits;
}

type AllowedHitReason = 'tombstone' | 'signed-stub' | 'c3-reference' | 'historical-note';

interface AllowedHit {
  file: string;
  identifier: (typeof MOVED_IDENTIFIERS)[number];
  reason: AllowedHitReason;
}

// The S18-F1 allowed-hits list (§5b ruling, amended A3) — per-file,
// per-identifier, each with the ONE reason it stays. Every remaining hit in
// the SWEPT tree (post U4's comment-truth sweep) is accounted for below;
// nothing here is a blanket exemption for a moved identifier — it names the
// specific surviving mentions and why each one is truthful doc, not stale.
const ALLOWED_HITS: readonly AllowedHit[] = [
  // The barrel's "GONE FROM THIS BARREL" epitaph (index.ts:250, added by
  // U2's signed Part D) names both moved symbols on purpose — an export
  // list with no trace of what left it would be less honest, not more.
  // The neighbouring D56 module-split note (index.ts:183, pre-dating the
  // move) explains why the orchestrator's founding composers are a
  // SEPARATE module from this one — same file, same tombstone context.
  { file: 'index.ts', identifier: 'composeStageInstruction', reason: 'tombstone' },
  { file: 'index.ts', identifier: 'StageInstructionContext', reason: 'tombstone' },
  // schemas.ts:389 — a "Consumer:" doctrine comment naming which composer's
  // fix-seed branch reads `lastReview`/`lastCompletion`. Informational
  // provenance, unrelated to the boundary mechanism itself.
  { file: 'schemas.ts', identifier: 'composeStageInstruction', reason: 'historical-note' },
  // sessionIdentity.ts:67 — the c3 exemption's OWN boundary comment: the
  // `Task:` marker logic is restated (not imported) here so this module
  // stays a leaf, and the coupling to the real composer is held by a test.
  // This IS c3; the identifier's presence is the point, not a leftover.
  { file: 'sessionIdentity.ts', identifier: 'composeStageInstruction', reason: 'c3-reference' },
  // sessionIdentity.test.ts:266,293,295,386 — the S18·U2 frozen-fixture
  // provenance comments: every briefing string below was RECORDED from a
  // real `composeStageInstruction` call before the move (c3 doctrine), and
  // says so. Historical record of where the bytes came from, not a live
  // reference to code that no longer lives here.
  { file: 'sessionIdentity.test.ts', identifier: 'composeStageInstruction', reason: 'historical-note' },
  // projections/sessions.test.ts:1567 — points the reader at
  // sessionIdentity.test.ts for "the unit-level proof", naming the composer
  // for context. Same historical-provenance shape as the entry above.
  {
    file: 'projections/sessions.test.ts',
    identifier: 'composeStageInstruction',
    reason: 'historical-note',
  },
  // tasks/workOrder.ts:126 — the numbered positional STUB §3.4/U2's
  // checkpoint explicitly signs ("keeps its position and its number...
  // exactly as sections 4/5 above do"). The stub's own existence requires
  // naming the schema that left.
  { file: 'tasks/workOrder.ts', identifier: 'createTaskToolPayloadSchema', reason: 'signed-stub' },
];

function isAllowedHit(hit: Hit): boolean {
  return ALLOWED_HITS.some((a) => a.file === hit.file && a.identifier === hit.identifier);
}

describe('S18 §3.4/A3 — moved-vocabulary grep gate', () => {
  it('every hit not covered by the signed ALLOWED_HITS list fails, file:line named', () => {
    const hits = findMovedVocabularyHits();
    const unlisted = hits.filter((h) => !isAllowedHit(h));
    const rendered = unlisted
      .map((h) => `  ${h.file}:${h.line}: [${h.identifier}] ${h.text}`)
      .join('\n');
    expect(
      unlisted,
      `unlisted moved-vocabulary hits found (not in ALLOWED_HITS):\n${rendered}`,
    ).toEqual([]);
  });

  it('every ALLOWED_HITS entry still has at least one matching hit (a stale listing fails)', () => {
    const hits = findMovedVocabularyHits();
    const stale = ALLOWED_HITS.filter(
      (a) => !hits.some((h) => h.file === a.file && h.identifier === a.identifier),
    );
    const rendered = stale.map((a) => `  ${a.file}: [${a.identifier}] (${a.reason})`).join('\n');
    expect(stale, `stale ALLOWED_HITS entries with no matching hit:\n${rendered}`).toEqual([]);
  });

  describe('§3.4 exemption enumeration (c1-c5) — the ONLY vocabulary allowed to stay', () => {
    it('c1: taskStageSchema, taskRecordSchema, and submitPlanPayloadSchema are exported from core', () => {
      const schemas = fs.readFileSync(path.join(CORE_SRC, 'schemas.ts'), 'utf8');
      const workOrder = fs.readFileSync(path.join(CORE_SRC, 'tasks', 'workOrder.ts'), 'utf8');
      expect(/\bexport const taskStageSchema\b/.test(schemas)).toBe(true);
      expect(/\bexport const taskRecordSchema\b/.test(schemas)).toBe(true);
      expect(/\bexport const submitPlanPayloadSchema\b/.test(workOrder)).toBe(true);
    });

    it('c2: taskRef anchors the session-shape schema', () => {
      const schemas = fs.readFileSync(path.join(CORE_SRC, 'schemas.ts'), 'utf8');
      expect(/\btaskRef\s*:/.test(schemas)).toBe(true);
    });

    it('c3: the Task: marker logic lives in sessionIdentity.ts, keyed off DISPATCH_BRIEFING_STEM', () => {
      const sessionIdentity = fs.readFileSync(path.join(CORE_SRC, 'sessionIdentity.ts'), 'utf8');
      expect(/\bDISPATCH_BRIEFING_STEM\b/.test(sessionIdentity)).toBe(true);
      expect(/=\s*'Task:'/.test(sessionIdentity)).toBe(true);
    });

    it('c4: legacyTasksView.ts exists and its header names its slice-18 death trigger', () => {
      const file = path.join(CORE_SRC, 'projections', 'legacyTasksView.ts');
      expect(fs.existsSync(file)).toBe(true);
      const text = fs.readFileSync(file, 'utf8');
      expect(/slice-18/.test(text)).toBe(true);
    });

    it('c5: tasks/ survives holding ONLY the engine stayers — no quiet additions', () => {
      const tasksDir = path.join(CORE_SRC, 'tasks');
      const entries = fs.readdirSync(tasksDir).sort();
      const expectedStems = [
        'dispatchDecision',
        'reviewOutcome',
        'stageRunner',
        'taskStateMachine',
        'watchdogDecision',
        'workOrder',
      ];
      const expected = expectedStems
        .flatMap((stem) => [`${stem}.test.ts`, `${stem}.ts`])
        .sort();
      expect(entries).toEqual(expected);
    });
  });
});
