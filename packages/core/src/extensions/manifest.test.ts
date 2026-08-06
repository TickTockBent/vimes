import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TASK_STAGE_EDGES } from '../tasks/taskStateMachine.js';
import {
  API_VERSION,
  KNOWN_ATTENTION_RANKS,
  KNOWN_CAPABILITIES,
  RESERVED_AUTHORITY_PROPERTIES,
  isSemver,
  isSemverRange,
  parseExtensionManifest,
  preParseApiVersion,
  type ManifestIssue,
  type ParsedManifest,
} from './manifest.js';

// ─── S10·Move-1a (D72) — the manifest parser's assertions ────────────────────
//
// S10-A2 (the differential), S10-A3 (refusals refuse), S10-A4 (degrades
// degrade) and S10-A5 (parse is pure) all live here. Reading order matches the
// assertion order in slice-10.md.
//
// ⚠ NOTHING IN THIS FILE MOCKS THE FILESYSTEM, and that is the point of S10-A5:
// the only disk access anywhere below is the test reading its own fixture. The
// parser is text-in / result-out.

// packages/core/src/extensions/ -> src/ -> core/ -> packages/ -> repo root.
const FIXTURE_PATH = fileURLToPath(
  new URL('../../../../fixtures/extensions/vimes-tasks/vimes-extension.toml', import.meta.url),
);

function readFixture(): string {
  return readFileSync(FIXTURE_PATH, 'utf8');
}

function codes(issues: readonly ManifestIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

function expectRefusal(text: string, code: string, options: Parameters<typeof parseExtensionManifest>[1] = {}): ManifestIssue {
  const result = parseExtensionManifest(text, options);
  if (result.ok) {
    throw new Error(`expected a refusal with code "${code}", but the manifest parsed cleanly`);
  }
  const issue = result.errors.find((error) => error.code === code);
  if (issue === undefined) {
    throw new Error(
      `expected a refusal with code "${code}"; got ${JSON.stringify(codes(result.errors))}`,
    );
  }
  return issue;
}

function expectManifest(text: string): ParsedManifest {
  const result = parseExtensionManifest(text);
  if (!result.ok) {
    throw new Error(`expected a clean parse; got ${JSON.stringify(result.errors, null, 2)}`);
  }
  return result.manifest;
}

// A minimal but VALID manifest, assembled in the ONLY order TOML allows:
// top-level bare keys, then `[runtime]`, then the array-of-table sections.
//
// ⚠ The builder exists because writing these by concatenation walks straight
// into §2.1's ordering hazard — appending `vimes_version = …` after `[runtime]`
// binds it to `runtime`, which the parser (correctly) refuses. That happened
// while writing this file, which is the cheapest possible evidence that the
// hazard is real and the refusal is worth having.
const MANIFEST_HEAD = `id = "demo"
name = "Demo"
version = "1.0.0"
api_version = 1
`;

function buildManifest(
  parts: { topLevel?: string; runtime?: string; body?: string } = {},
): string {
  return [
    MANIFEST_HEAD,
    parts.topLevel ?? '',
    '\n[runtime]\n',
    parts.runtime ?? 'kind = "in-process"\n',
    '\n',
    parts.body ?? '',
  ].join('');
}

// Every refusal test below is this document plus exactly one defect, so the
// refusal cannot be an accident of the scaffolding.
const MINIMAL = buildManifest();

// ── S10-A2 — THE DIFFERENTIAL ────────────────────────────────────────────────
//
// slice-10.md: "the parsed vimes-tasks manifest's expanded edge table equals
// TASK_STAGE_EDGES edge-for-edge (the declared `manual-review` edges the only
// additions)."
//
// node-kit §1.9 wrote this check into the document itself — "the block below
// was parsed as TOML, its wildcard rows expanded, its forbidden row subtracted,
// and the result diffed against TASK_STAGE_EDGES" — and recorded that the same
// check found FOUR errors in its own first draft (two edges silently lost, two
// silently invented). "Whatever ships as the migration must carry that diff as
// a test." This is that test.

const MANUAL_REVIEW_NODE = 'manual-review';

function shippedEdgeSet(): Set<string> {
  const edges = new Set<string>();
  for (const [from, targets] of TASK_STAGE_EDGES) {
    for (const to of targets) edges.add(`${from} -> ${to}`);
  }
  return edges;
}

describe('S10-A2 the differential — the declared edge table IS TASK_STAGE_EDGES', () => {
  const manifest = expectManifest(readFixture());
  const workflow = manifest.workflows.find((candidate) => candidate.id === 'software');

  it('declares exactly one workflow, `software`, over the nine shipped stages plus manual-review', () => {
    expect(manifest.workflows).toHaveLength(1);
    expect(workflow).toBeDefined();
    expect(workflow?.initial).toBe('backlog');
    expect(new Set(workflow?.nodes.map((node) => node.id))).toEqual(
      new Set([...TASK_STAGE_EDGES.keys(), MANUAL_REVIEW_NODE]),
    );
  });

  it('expands, subtracts nothing, and equals TASK_STAGE_EDGES in BOTH directions', () => {
    const declared = new Set(
      (workflow?.edges ?? []).map((edge) => `${edge.from} -> ${edge.to}`),
    );
    const shipped = shippedEdgeSet();

    // The ONLY sanctioned difference: the convergence exit's out-edges. It has
    // no in-edge by design (reachable only through `on_exhausted`), so it
    // contributes out-edges and nothing else.
    const manualReviewEdges = [...declared].filter((edge) =>
      edge.startsWith(`${MANUAL_REVIEW_NODE} -> `),
    );
    expect(new Set(manualReviewEdges)).toEqual(
      new Set([
        // written explicitly in the table
        `${MANUAL_REVIEW_NODE} -> done`,
        `${MANUAL_REVIEW_NODE} -> implementing`,
        // node-kit §1.9: "arrives through the `* → cancelled` wildcard, and it
        // is kept deliberately — the give-up that can be undone applies to the
        // convergence exit too."
        `${MANUAL_REVIEW_NODE} -> cancelled`,
      ]),
    );

    const declaredWithoutManualReview = new Set(
      [...declared].filter((edge) => !edge.startsWith(`${MANUAL_REVIEW_NODE} -> `)),
    );

    const missingFromDeclared = [...shipped]
      .filter((edge) => !declaredWithoutManualReview.has(edge))
      .sort();
    const inventedByDeclared = [...declaredWithoutManualReview]
      .filter((edge) => !shipped.has(edge))
      .sort();

    // A mismatch prints the differing edges — the first draft of node-kit §1.9
    // "looked right while being wrong", and only a printed diff says otherwise.
    expect({ missingFromDeclared, inventedByDeclared }).toEqual({
      missingFromDeclared: [],
      inventedByDeclared: [],
    });
    expect(declaredWithoutManualReview).toEqual(shipped);
    expect(declaredWithoutManualReview.size).toBe(shipped.size);
  });

  it('quarantines exactly `quarantined -> done`, with its own named refusal reason', () => {
    // node-kit §1.4.4: an absent edge refuses `illegal-edge`, which is right for
    // a typo and WRONG for a safety rule. This row is why `forbidden` exists.
    expect(workflow?.forbidden).toEqual([
      { from: 'quarantined', to: 'done', reason: 'quarantined-cannot-complete' },
    ]);
    // And it is genuinely absent from the legality table, not merely shadowed.
    expect(
      (workflow?.edges ?? []).some((edge) => edge.from === 'quarantined' && edge.to === 'done'),
    ).toBe(false);
  });

  it('carries the bounded review/fix loop with its engine-owned counter and exhaustion exit', () => {
    const loop = (workflow?.edges ?? []).find(
      (edge) => edge.from === 'review' && edge.to === 'implementing',
    );
    expect(loop?.maxTraversals).toBe(3);
    expect(loop?.onExhausted).toBe(MANUAL_REVIEW_NODE);
    expect(loop?.by).toEqual(['dispatcher', 'human', 'orchestrator']);
  });

  it('stamps quarantine moves `watchdog` — the proposer class that does not exist today', () => {
    // node-kit §1.9: naming the class in the edge table is what makes the
    // addition reviewable, rather than the watchdog borrowing `dispatcher`.
    const quarantineEdges = (workflow?.edges ?? []).filter((edge) => edge.to === 'quarantined');
    expect(quarantineEdges.map((edge) => edge.from).sort()).toEqual([
      'implementing',
      'planning',
      'review',
    ]);
    for (const edge of quarantineEdges) expect(edge.by).toEqual(['watchdog']);
  });
});

describe('the vimes-tasks fixture — the rest of §3.1 made literal', () => {
  const manifest = expectManifest(readFixture());

  it('carries §3.1 identity, capabilities and Tier-1 runtime', () => {
    expect(manifest.id).toBe('vimes-tasks');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.apiVersion).toBe(API_VERSION);
    expect(manifest.runtime).toEqual({ kind: 'in-process', command: undefined, system: false });
    expect(manifest.capabilities).toEqual([
      'tree.read',
      'tree.write',
      'session.dispatch',
      'session.unattended',
      'session.read',
      'session.kill',
      'blob.read',
      'blob.write',
      'overlay.write',
      'notify',
      'ledger.read',
    ]);
    for (const capability of manifest.capabilities) {
      expect(KNOWN_CAPABILITIES).toContain(capability);
    }
  });

  it('declares the seven two-faced verbs, three of them shipped today', () => {
    expect(manifest.verbs.map((verb) => verb.id)).toEqual([
      'create_task',
      'promote',
      'move',
      'dispatch',
      'amend',
      'report_review',
      'report_completion',
    ]);
    for (const verb of manifest.verbs) {
      expect(verb.agent).toBeDefined();
      expect(verb.human).toBeDefined();
    }
    expect(manifest.verbs.find((verb) => verb.id === 'create_task')?.agent).toEqual({
      server: 'vimes_board',
      tool: 'create_task',
    });
  });

  it('carries NO `offered_when` — D55s matrix is three node `tools` lists instead (q14)', () => {
    // Declarations only: the header comment NAMES the retired field to explain
    // why it is absent, which is exactly the kind of prose a `toContain` over
    // the whole file would trip on.
    const declarations = readFixture()
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(declarations).not.toContain('offered_when');
    const nodes = manifest.workflows[0]?.nodes ?? [];
    const toolsFor = (id: string): readonly string[] =>
      nodes.find((node) => node.id === id)?.briefing?.tools ?? [];
    expect(toolsFor('planning')).toEqual([]);
    expect(toolsFor('implementing')).toEqual(['vimes_report.report_completion']);
    expect(toolsFor('review')).toEqual(['vimes_report.report_review']);
  });

  it('subscribes to `meter_alert`, never the deprecated `meter_threshold_crossed`', () => {
    expect(manifest.events.map((event) => event.on)).toEqual([
      'run_completed',
      'liveness_changed',
      'dispatch_refused',
      'meter_alert',
    ]);
    for (const event of manifest.events) expect(event.deliver).toBe('worker');
  });

  it('declares both overlays with their attention ranks, and both panes with a degradation', () => {
    expect(manifest.overlays.map((overlay) => overlay.id)).toEqual([
      'task-stage',
      'task-stage-node',
    ]);
    expect(manifest.overlays[0]?.attention).toEqual([
      { value: 'review', rank: 'attention.v1.needs-human' },
      { value: 'quarantined', rank: 'attention.v1.blocked' },
    ]);
    expect(manifest.panes.map((pane) => `${pane.id}:${pane.degrade}`)).toEqual([
      'board:link',
      'work-order:omit',
    ]);
  });

  it('resolves node properties by composing the declared kinds', () => {
    const nodes = manifest.workflows[0]?.nodes ?? [];
    const planning = nodes.find((node) => node.id === 'planning');
    // `work`: attaches a session, dispatches on entry for human/orchestrator
    // only (D53's no-chaining rule), isolates in a worktree — plus the node's
    // own D48 plan-mode override.
    expect(planning?.properties).toEqual({
      attachesSession: true,
      terminal: false,
      dispatchOnEntry: { enabled: true, by: ['human', 'orchestrator'] },
      isolation: 'worktree',
      permissionMode: 'plan',
      attention: undefined,
    });
    // D53: review is a HOLDING PEN — it attaches a session but entry never
    // dispatches one.
    const review = nodes.find((node) => node.id === 'review');
    expect(review?.properties.attachesSession).toBe(true);
    expect(review?.properties.dispatchOnEntry).toEqual({ enabled: false, by: [] });
    expect(review?.properties.attention).toBe('attention.v1.needs-human');
    // `done` is the only terminal node.
    expect(nodes.filter((node) => node.properties.terminal).map((node) => node.id)).toEqual([
      'done',
    ]);
  });

  it('carries the four acceptance shapes §1.9 uses, and nothing on the hold nodes', () => {
    const nodes = manifest.workflows[0]?.nodes ?? [];
    const acceptanceFor = (id: string) => nodes.find((node) => node.id === id)?.acceptance;
    expect(acceptanceFor('planning')).toMatchObject({
      kind: 'artifact',
      requires: ['capture:plan'],
      onPass: 'plan-ready',
    });
    expect(acceptanceFor('implementing')).toMatchObject({ kind: 'report', onPass: 'review' });
    expect(acceptanceFor('review')).toMatchObject({
      kind: 'rubric',
      coverage: 'all-criteria-pass',
      unlistedIds: 'ignore',
      onPass: 'done',
      onFail: 'implementing',
    });
    // §1.8.4 (f) NONE — a hold node rests, and something proposes the move.
    for (const id of ['backlog', 'plan-ready', 'done', 'manual-review', 'blocked-external']) {
      expect(acceptanceFor(id)).toBeUndefined();
    }
  });

  it('lists exactly one warning: the two wildcard rows that overlap on one edge', () => {
    const result = parseExtensionManifest(readFixture());
    expect(result.ok).toBe(true);
    // `blocked-external -> cancelled` is produced by BOTH the park's `to = "*"`
    // and the give-up's `from = "*"`. The rows agree, so it is deduped — and
    // warned, because an overlap invisible in the listed table is an overlap
    // nobody reviewed.
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'edge-duplicate-expansion' }),
    ]);
    expect(result.warnings[0]?.message).toContain('blocked-external → cancelled');
  });
});

// ── S10-A5 — parse is pure ───────────────────────────────────────────────────

describe('S10-A5 parse is pure', () => {
  it('yields deep-equal results for the same text, twice', () => {
    const text = readFixture();
    expect(parseExtensionManifest(text)).toEqual(parseExtensionManifest(text));
  });

  it('yields deep-equal refusals for the same broken text, twice', () => {
    const broken = `${MINIMAL}\ncapabilities = ["not.a.capability"]\n`;
    expect(parseExtensionManifest(broken)).toEqual(parseExtensionManifest(broken));
  });

  it('never throws on garbage input — a refusal is a normal outcome', () => {
    for (const garbage of ['', '???', '[[', 'id = ', '\u0000', 'id = "x"\nid = "y"']) {
      expect(() => parseExtensionManifest(garbage)).not.toThrow();
      expect(parseExtensionManifest(garbage).ok).toBe(false);
    }
  });
});

// ── S10-A3 — refusals refuse ─────────────────────────────────────────────────

describe('S10-A3 refusals — identity and versions (§2.2 / §2.3)', () => {
  it('refuses a non-semver `version` (the deliberate divergence from herdr)', () => {
    const issue = expectRefusal(MINIMAL.replace('version = "1.0.0"', 'version = "1.4"'), 'version-not-semver');
    expect(issue.path).toBe('version');
    expect(issue.message).toContain('semver');
  });

  it('accepts the semver grammar and rejects its near misses', () => {
    expect(isSemver('1.0.0')).toBe(true);
    expect(isSemver('1.0.0-rc.1+build.5')).toBe(true);
    expect(isSemver('1.4')).toBe(false);
    expect(isSemver('v1.0.0')).toBe(false);
    expect(isSemver('01.0.0')).toBe(false);
  });

  it('validates `vimes_version` as a RANGE, not a version', () => {
    expect(isSemverRange('>=0.9, <2')).toBe(true);
    expect(isSemverRange('^1.2.3')).toBe(true);
    expect(isSemverRange('>=1.2 <2')).toBe(true);
    expect(isSemverRange('not a range')).toBe(false);
    expectRefusal(
      buildManifest({ topLevel: 'vimes_version = "yesterday"\n' }),
      'vimes-version-not-range',
    );
  });

  it('refuses an out-of-grammar id, and a dotted SECTION-local id', () => {
    expectRefusal(MINIMAL.replace('id = "demo"', 'id = "demo extension!"'), 'id-charset');
    // §2.2: the engine composes qualified names with dots, so a dot inside a
    // local id makes `vimes-tasks.promote` ambiguous.
    const dotted = `${MINIMAL}
[[verbs]]
id = "a.b"
title = "T"
target = "task"
input = "s.json"
human = { command = "x" }
`;
    expectRefusal(dotted, 'id-charset');
  });

  it('refuses duplicate ids within a section', () => {
    const duplicated = `${MINIMAL}
[[verbs]]
id = "promote"
title = "Promote"
target = "task"
input = "schemas/promote.json"
human = { command = "promote" }

[[verbs]]
id = "promote"
title = "Promote again"
target = "task"
input = "schemas/promote.json"
human = { command = "promote2" }
`;
    const issue = expectRefusal(duplicated, 'duplicate-id');
    expect(issue.path).toBe('verbs[1].id');
  });

  it('refuses a too-new `api_version` with "upgrade vimes", naming the version', () => {
    const issue = expectRefusal(MINIMAL.replace('api_version = 1', 'api_version = 7'), 'api-version-too-new');
    expect(issue.message).toContain('api_version = 7');
    expect(issue.message).toContain('Upgrade vimes');
  });

  it('pre-parses `api_version` PERMISSIVELY, so a too-new manifest fails on the version, not on parse noise', () => {
    // §2.3 property 1. This document is not valid TOML at all past line 2 —
    // yet the refusal is still the useful one.
    const tooNewAndBroken = 'api_version = 9\nthis is not = = toml\n';
    expect(preParseApiVersion(tooNewAndBroken)).toBe(9);
    const result = parseExtensionManifest(tooNewAndBroken);
    expect(result.ok).toBe(false);
    expect(codes(result.ok ? [] : result.errors)).toEqual(['api-version-too-new']);
  });

  it('gates FIELD BY FIELD against an injected vocabulary map (§2.3)', () => {
    // v1 introduced everything at 1, so the shipped map is empty — the
    // MECHANISM is what this asserts, by injecting a field that "landed" later.
    const withField = buildManifest({ runtime: 'kind = "in-process"\nsystem = false\n' });
    const issue = expectRefusal(withField, 'field-requires-newer-api-version', {
      fieldVocabulary: { 'runtime.system': 3 },
    });
    expect(issue.message).toContain('requires api_version >= 3');
    expect(issue.path).toBe('runtime.system');
    // …and the same field passes once the manifest declares the vocabulary.
    const declared = parseExtensionManifest(withField.replace('api_version = 1', 'api_version = 3'), {
      hostApiVersion: 3,
      fieldVocabulary: { 'runtime.system': 3 },
    });
    expect(declared.ok).toBe(true);
  });
});

describe('S10-A3 refusals — capabilities (§5.3 rule 1)', () => {
  it('refuses an unknown capability, naming the supported set and "upgrade vimes"', () => {
    const issue = expectRefusal(
      buildManifest({ topLevel: 'capabilities = ["session.teleport"]\n' }),
      'unknown-capability',
    );
    expect(issue.message).toContain('session.teleport');
    expect(issue.message).toContain('tree.read');
    expect(issue.message).toContain('Upgrade vimes');
  });

  it('KNOWS the reserved-and-never-granted strings — known is not grantable', () => {
    // §5.3: `records.read`/`records.write` are reserved and permanently empty in
    // v1; `extension.manage` is declared and never granted. The PARSER's job is
    // to recognise the vocabulary; the grant is D67's and Move 1b's.
    for (const capability of ['records.read', 'records.write', 'extension.manage']) {
      expect(KNOWN_CAPABILITIES).toContain(capability);
    }
  });
});

describe('S10-A3 refusals — verbs and the #13 authority rule (§2.4)', () => {
  const verbWithArg = (from: string): string => `${MINIMAL}
[[verbs]]
id = "promote"
title = "Promote"
target = "task"
input = "schemas/promote.json"

  [verbs.human]
  command = "promote"
  args = [ { name = "to", required = true, from = "${from}" } ]
`;

  it('refuses an args path whose leaf names a reserved authority property', () => {
    for (const property of RESERVED_AUTHORITY_PROPERTIES) {
      const issue = expectRefusal(verbWithArg(`input.${property}`), 'reserved-authority-property');
      expect(issue.message).toContain(property);
    }
    // …including one nested inside the schema.
    expectRefusal(verbWithArg('input.decision.approved'), 'reserved-authority-property');
    // The honest half-rule: a same-named path that is NOT the leaf is not the
    // property, and the registry (Move 1b) enforces the schema-file half.
    expect(parseExtensionManifest(verbWithArg('input.approved.note')).ok).toBe(true);
  });

  it('refuses `offered_when` anywhere on a verb, naming what replaced it', () => {
    const withPredicate = `${MINIMAL}
[[verbs]]
id = "promote"
title = "Promote"
target = "task"
input = "schemas/promote.json"
agent = { server = "vimes_board", tool = "promote_task", offered_when = "stage in [review]" }
`;
    const issue = expectRefusal(withPredicate, 'offered-when-retired');
    expect(issue.message).toContain('briefing');
    expect(issue.message).toContain('GRANTED');
  });

  it('refuses a verb nobody can invoke', () => {
    expectRefusal(
      `${MINIMAL}
[[verbs]]
id = "ghost"
title = "Ghost"
target = "task"
input = "schemas/ghost.json"
`,
      'verb-no-face',
    );
  });
});

describe('S10-A3 refusals — overlays, panes, runtime', () => {
  it('refuses an unknown attention rank — §2.5s deliberate degrade-BREAK', () => {
    const overlay = `${MINIMAL}
[[overlays]]
id = "stage"
target = "session"
key = "stage"
type = "enum"
values = ["review"]
attention = [ { value = "review", rank = "attention.v1.on-fire" } ]
`;
    const issue = expectRefusal(overlay, 'unknown-attention-rank');
    expect(issue.message).toContain('attention.v1.on-fire');
    for (const rank of KNOWN_ATTENTION_RANKS) expect(issue.message).toContain(rank);
  });

  it('refuses a pane that declares no degradation (migration-map §3.4)', () => {
    const pane = `${MINIMAL}
[[panes]]
id = "board"
title = "Board"
kind = "blocks"
scope = "project"
placement = "main"
source = "panes/board"
`;
    const issue = expectRefusal(pane, 'field-missing');
    expect(issue.path).toBe('panes[0].degrade');
  });

  it('refuses an in-process runtime that ships a command, and a Tier-2 one that does not', () => {
    expectRefusal(
      buildManifest({ runtime: 'kind = "in-process"\ncommand = ["bin/worker"]\n' }),
      'runtime-command-forbidden',
    );
    expectRefusal(buildManifest({ runtime: 'kind = "worker"\n' }), 'runtime-command-required');
    // argv, never a shell string.
    expectRefusal(
      buildManifest({ runtime: 'kind = "worker"\ncommand = "bin/worker --serve"\n' }),
      'runtime-command-not-argv',
    );
    // …and the Tier-2 form that IS well-shaped parses.
    expect(
      parseExtensionManifest(
        buildManifest({ runtime: 'kind = "worker"\ncommand = ["bin/worker", "--serve"]\n' }),
      ).ok,
    ).toBe(true);
  });

  it('refuses `capabilities` that TOML bound to a table, naming the ordering hazard (§2.1)', () => {
    // The failure this catches is QUIET: the manifest parses, `capabilities`
    // simply is not where the author put it.
    const hazard = `${MINIMAL}capabilities = ["tree.read"]\n`;
    const issue = expectRefusal(hazard, 'top-level-key-bound-to-table');
    expect(issue.path).toBe('runtime.capabilities');
    expect(issue.message).toContain('most recently opened table');
  });
});

// The node kit's own refusals (node-kit §1). Each test carries the minimum
// workflow that makes its defect the ONLY thing wrong.
const KIT_PREAMBLE = `${MINIMAL}
[[node-kinds]]
id = "work"
attaches_session = true

[[node-kinds]]
id = "hold"
`;

describe('S10-A3 refusals — the node kit (node-kit §1)', () => {
  it('refuses an unrecognised node-kind PROPERTY (§1.2 — the vocabulary is CLOSED)', () => {
    const issue = expectRefusal(
      `${MINIMAL}
[[node-kinds]]
id = "work"
attaches_sessions = true
`,
      'unknown-node-property',
    );
    expect(issue.path).toBe('node-kinds[0].attaches_sessions');
    expect(issue.message).toContain('CLOSED');
  });

  it('refuses an unknown proposer class in `by` (q17)', () => {
    const issue = expectRefusal(
      `${KIT_PREAMBLE}
[[workflows]]
id = "w"
title = "W"
initial = "a"
edges = [ { from = "a", to = "b", by = ["intern"] } ]

[[workflows.nodes]]
id = "a"
kind = "hold"

[[workflows.nodes]]
id = "b"
kind = "hold"
`,
      'unknown-proposer-class',
    );
    expect(issue.message).toContain('watchdog');
  });

  it('refuses `permission_mode = "plan"` with a non-empty `tools` list, naming D55s incident', () => {
    const issue = expectRefusal(
      `${KIT_PREAMBLE}
[[workflows]]
id = "w"
title = "W"
initial = "a"
edges = [ { from = "a", to = "b", by = ["human"] } ]

[[workflows.nodes]]
id = "a"
kind = "work"
permission_mode = "plan"
  [workflows.nodes.briefing]
  composer = "briefings/a"
  tools = ["vimes_report.report_completion"]

[[workflows.nodes]]
id = "b"
kind = "hold"
`,
      'plan-mode-with-tools',
    );
    expect(issue.message).toContain('D55');
    expect(issue.message).toContain('waits forever');
  });

  it('refuses an unreachable node (reachability spans on_exhausted / on_pass / on_fail)', () => {
    const issue = expectRefusal(
      `${KIT_PREAMBLE}
[[workflows]]
id = "w"
title = "W"
initial = "a"
edges = [ { from = "a", to = "b", by = ["human"] } ]

[[workflows.nodes]]
id = "a"
kind = "hold"

[[workflows.nodes]]
id = "b"
kind = "hold"

[[workflows.nodes]]
id = "orphan"
kind = "hold"
`,
      'node-unreachable',
    );
    expect(issue.message).toContain('orphan');

    // …and the SAME graph parses once `orphan` is reachable through an
    // `on_exhausted` route nobody may propose — node-kit §1.9's `manual-review`
    // case, which a naive edges-only reachability check would call an orphan.
    const viaExhaustion = `${KIT_PREAMBLE}
[[workflows]]
id = "w"
title = "W"
initial = "a"
edges = [ { from = "a", to = "b", by = ["human"], max_traversals = 2, on_exhausted = "orphan" } ]

[[workflows.nodes]]
id = "a"
kind = "hold"

[[workflows.nodes]]
id = "b"
kind = "hold"

[[workflows.nodes]]
id = "orphan"
kind = "hold"
`;
    expect(parseExtensionManifest(viaExhaustion).ok).toBe(true);
  });

  it('refuses an unknown node reference and an `initial` that names no node', () => {
    expectRefusal(
      `${KIT_PREAMBLE}
[[workflows]]
id = "w"
title = "W"
initial = "nowhere"
edges = [ { from = "a", to = "b", by = ["human"] } ]

[[workflows.nodes]]
id = "a"
kind = "hold"

[[workflows.nodes]]
id = "b"
kind = "hold"
`,
      'unknown-node-reference',
    );
  });

  it('NEVER expands a wildcard into a self-edge (§1.4.3)', () => {
    // `* → b` over {a, b} would yield `b → b` under a naive expansion; the
    // phantom edge would then sit in the LISTED table, which is the artifact a
    // reviewer reads.
    const wildcard = `${KIT_PREAMBLE}
[[workflows]]
id = "w"
title = "W"
initial = "a"
edges = [ { from = "*", to = "b", by = ["human"] } ]

[[workflows.nodes]]
id = "a"
kind = "hold"

[[workflows.nodes]]
id = "b"
kind = "hold"
`;
    const manifest = expectManifest(wildcard);
    const edges = (manifest.workflows[0]?.edges ?? []).map((edge) => `${edge.from} -> ${edge.to}`);
    expect(edges).toEqual(['a -> b']);
    expect(edges).not.toContain('b -> b');
    // The expanded row still remembers the wildcard it came from, so the
    // listing can show both.
    expect(manifest.workflows[0]?.edges[0]?.declaredFrom).toBe('*');
  });

  it('refuses a hand-written self-edge (a wildcard drops it; an author declaring it is a mistake)', () => {
    expectRefusal(
      `${KIT_PREAMBLE}
[[workflows]]
id = "w"
title = "W"
initial = "a"
edges = [ { from = "a", to = "a", by = ["human"] } ]

[[workflows.nodes]]
id = "a"
kind = "hold"
`,
      'edge-self-loop',
    );
  });

  it('refuses a capture name outside the engine catalogue, and an unknown briefing input prefix', () => {
    const withCapture = (input: string, capture: string): string => `${KIT_PREAMBLE}
[[workflows]]
id = "w"
title = "W"
initial = "a"
edges = [ { from = "a", to = "b", by = ["human"] } ]

[[workflows.nodes]]
id = "a"
kind = "work"
  [workflows.nodes.briefing]
  composer = "briefings/a"
  inputs = ["${input}"]
  capture = ["${capture}"]

[[workflows.nodes]]
id = "b"
kind = "hold"
`;
    expectRefusal(withCapture('instance.record', 'screenshot'), 'unknown-capture-name');
    expectRefusal(withCapture('secret:everything', 'plan'), 'briefing-input-unknown-prefix');
    expect(parseExtensionManifest(withCapture('doctrine/a.md', 'plan')).ok).toBe(true);
  });

  it('refuses a max_traversals that is not a positive integer', () => {
    expectRefusal(
      `${KIT_PREAMBLE}
[[workflows]]
id = "w"
title = "W"
initial = "a"
edges = [ { from = "a", to = "b", by = ["human"], max_traversals = 0, on_exhausted = "b" } ]

[[workflows.nodes]]
id = "a"
kind = "hold"

[[workflows.nodes]]
id = "b"
kind = "hold"
`,
      'edge-max-traversals-invalid',
    );
  });
});

// ── S10-A4 — degrades degrade ────────────────────────────────────────────────

describe('S10-A4 degrades — an unfirable hook is listed, never a refusal (§2.6)', () => {
  const withEvent = (on: string): string => `${MINIMAL}
[[events]]
on = "${on}"
deliver = "worker"
`;

  it('WARNS on an unknown event kind and still parses', () => {
    const result = parseExtensionManifest(withEvent('star_aligned'));
    expect(result.ok).toBe(true);
    expect(codes(result.warnings)).toEqual(['unknown-event-kind']);
    expect(result.warnings[0]?.message).toContain('never fire');
  });

  it('WARNS on the DEPRECATED kind, naming `meter_alert` as the replacement', () => {
    // §4.2 q8's own near-miss: `meter_threshold_crossed` is retained for
    // historical validation with ZERO producers, so a subscription waits
    // forever. An allowlist that cannot say "this string used to mean
    // something" ships the silent failure the versioning exists to prevent.
    const result = parseExtensionManifest(withEvent('meter_threshold_crossed'));
    expect(result.ok).toBe(true);
    expect(codes(result.warnings)).toEqual(['deprecated-event-kind']);
    expect(result.warnings[0]?.message).toContain('meter_alert');
  });

  it('WARNS on a deprecated capability rather than silently no-oping it (§5.3 rule 3)', () => {
    // v1 has retired nothing, so the mechanism is asserted through injection —
    // the same shape the shipped empty map will take when something retires.
    const result = parseExtensionManifest(
      buildManifest({ topLevel: 'capabilities = ["legacy.read"]\n' }),
      { deprecatedCapabilities: { 'legacy.read': 'tree.read' } },
    );
    expect(result.ok).toBe(true);
    expect(codes(result.warnings)).toEqual(['deprecated-capability']);
    expect(result.warnings[0]?.message).toContain('tree.read');
  });

  it('WARNS (never refuses) on a verb target that is not an engine object kind', () => {
    // An extension RECORD kind is a legal target (node-kit §1.7), so an
    // unrecognised one is a forward reference this parser cannot disprove.
    const result = parseExtensionManifest(`${MINIMAL}
[[verbs]]
id = "score"
title = "Score"
target = "chapter"
input = "schemas/score.json"
human = { command = "score" }
`);
    expect(result.ok).toBe(true);
    expect(codes(result.warnings)).toContain('verb-target-not-engine-kind');
  });

  it('WARNS (never refuses) on an unknown field in a declarative section', () => {
    const result = parseExtensionManifest(`${MINIMAL}
[[panes]]
id = "board"
title = "Board"
kind = "blocks"
scope = "project"
placement = "main"
source = "panes/board"
degrade = "link"
sparkles = true
`);
    expect(result.ok).toBe(true);
    expect(codes(result.warnings)).toEqual(['unknown-field']);
    expect(result.warnings[0]?.path).toBe('panes[0].sparkles');
  });
});
