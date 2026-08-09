// ─── S10·Move-1a (D72) — the extension-manifest parser/validator ─────────────
//
// TOML text in, `ParsedManifest | refusal` out. **PURE** (S10-A5, rule 0.3):
// no filesystem, no clock, no randomness, no network. The daemon-side registry
// (Move 1b) owns every byte of I/O — including reading the `input` JSON Schema
// files this module can only name.
//
// The schema implemented here is SIGNED (D71). `private-docs/extension-model.md` §2
// (the manifest) + §5.3 (capability validation) and `private-docs/node-kit.md` §1 (the
// node kit) are the references; every rule below cites its section. This file
// implements them — it does not improve them.
//
// The one rule the whole file serves (extension-model §0):
//
//   > Extensions propose, the engine's deterministic core decides.
//
// Which has a mechanical consequence the parser is the first enforcer of: a
// declaration this module cannot validate WITHOUT executing something the
// extension shipped is not a declaration. Everything here is parse, list,
// refuse — never execute.
//
// ── the three-channel result (herdr/AoE lineage) ─────────────────────────────
// Errors and warnings are STRUCTURED (code + path + message), never bare
// strings: the registry lists them, clients render them, and tests assert on
// the code rather than on prose that will be reworded.

import { parse as parseToml, TomlError } from 'smol-toml';
import { z } from 'zod';
import { EVENT_TYPES, RETIRED_EVENT_KINDS } from '../events.js';

// ── the host's own versions and vocabularies ─────────────────────────────────

// The manifest VOCABULARY version this host understands (extension-model §2.3).
// Deliberately not the daemon version: `api_version` gates the manifest SHAPE,
// `vimes_version` gates host BEHAVIOUR.
export const API_VERSION = 1;

// §5.3's table, every string of it. **Known is not grantable**: the
// reserved-and-permanently-empty `records.read` / `records.write` pair (§5.3,
// pending §4.2 q6 option (a)) and `extension.manage` (declared and never
// granted in v1 — there is no install path to reach) are here because the
// parser's job is to recognise the vocabulary, not to decide the grant. Rule 1
// below only says an UNKNOWN string is refused.
export const KNOWN_CAPABILITIES: readonly string[] = [
  'tree.read',
  'tree.write',
  'session.read',
  'session.send',
  'session.dispatch',
  'session.unattended',
  'session.kill',
  'terminal.create',
  'events.subscribe',
  'verbs.register',
  'overlay.write',
  'notify',
  'blob.read',
  'blob.write',
  'ledger.read',
  // reserved, permanently empty in v1 (§5.3)
  'records.read',
  'records.write',
  // ⚠ the honesty note of §5.3 applies to these four: they gate what the
  // ENGINE will do on the extension's behalf, never what the extension's own
  // process can do.
  'fs.read',
  'fs.write',
  'net',
  'process.spawn',
  // the grant that grants grants — declared, never granted in v1
  'extension.manage',
];

// §5.3 rule 3: "a retired capability warns; it never silently no-ops". The
// mechanism ships now, EMPTY — v1 has retired nothing. Injectable so the
// mechanism is testable without inventing a retirement (see ParseManifestOptions).
export const DEPRECATED_CAPABILITIES: Readonly<Record<string, string>> = {};

// E2-b's explicit, versioned total order over attention states, as far as v1
// declares it. §2.5: an unknown rank is a HARD ERROR and that is the one place
// this model deliberately breaks herdr's degrade posture — "an unknown event
// kind merely means a hook never fires; an unknown attention rank means the
// rollup is wrong while looking right."
export const KNOWN_ATTENTION_RANKS: readonly string[] = [
  'attention.v1.needs-human',
  'attention.v1.blocked',
];

// §2.4's #13 rule: the engine stamps the proposer from the channel a proposal
// arrived on; a payload may never claim the decision happened.
//
// ⚠ THE SPLIT IS HONEST AND IT IS HALF A RULE HERE. The full rule refuses a
// verb whose `input` JSON Schema declares a property with one of these names —
// and a PURE parser cannot read that file (S10-A5). So:
//
//   • the manifest-level half, enforced below: a `verbs.human.args` entry whose
//     `from` path has a reserved leaf name is refused;
//   • the schema-file half, enforced in Move 1b: the registry CAN read
//     `input`, and it enforces the property-name rule against the real schema
//     using this exported list.
//
// Neither half is sufficient alone. Exported so the registry uses THIS list
// rather than re-typing it (principle 9).
export const RESERVED_AUTHORITY_PROPERTIES: readonly string[] = [
  'proposed_by',
  'approved',
  'authority',
  'actor',
];

// node-kit §1.4.1 + q17 (D71): the proposer classes, engine-stamped from the
// channel and matched POSITIVELY everywhere — `dispatchDecision.ts:99` records
// what the negated form costs ("reads identically today and fails open
// tomorrow").
export const proposerClassSchema = z.enum([
  'human',
  'orchestrator',
  'dispatcher',
  'watchdog',
  'extension',
]);
export type ProposerClass = z.infer<typeof proposerClassSchema>;

// §2.4: the engine object kinds a verb may target in v1. An extension RECORD
// kind is also legal (node-kit §1.7 makes instances real), so an unrecognised
// target is a WARNING, not a refusal — it is a forward reference, not a typo we
// can prove.
export const ENGINE_VERB_TARGETS: readonly string[] = ['task', 'session', 'node', 'project'];

// node-kit §1.8.3: the engine-shipped interception catalogue. CLOSED, and v1
// has exactly one entry in it — "an extension can opt into an interception; it
// cannot add one" (recorded there as a bend, not sold as generality).
export const CAPTURE_CATALOGUE: readonly string[] = ['plan'];

// §2.6 + §4.2 q8: `on` is validated against the engine's real event kinds.
// UNKNOWN is a WARNING (herdr's forward-compatible degrade: a manifest written
// for a newer engine still loads, and the hook that cannot fire says so).
export const ENGINE_EVENT_KINDS: readonly string[] = Object.values(EVENT_TYPES);

// §4.2 q8's own near-miss, made mechanical: the allowlist must carry
// DEPRECATION state, "or the versioning story ships the silent failure it
// exists to prevent". `meter_threshold_crossed` is retained-for-validation with
// zero producers (events.ts:66-78) — subscribing to it waits forever.
//
// ⚠ **THE S11 ROWS ARE DERIVED FROM `RETIRED_EVENT_KINDS` (events.ts), NEVER
// RESTATED.** The alias table is the one source of record for "this kind was
// retired and this is its sibling" (principle 9); a hand-copied list here would
// be a second one, and the day they disagreed the parser would either warn about
// a live kind or stay silent about a dead one. Retiring a kind is therefore ONE
// edit — add the alias row — and this map, the reducer's fold path and the
// manifest warning all move together.
export const DEPRECATED_EVENT_KINDS: Readonly<Record<string, string>> = {
  [EVENT_TYPES.meterThresholdCrossed]: EVENT_TYPES.meterAlert,
  ...Object.fromEntries(
    Object.entries(RETIRED_EVENT_KINDS).map(([retiredKind, row]) => [retiredKind, row.canonical]),
  ),
};

// §2.3's per-field gating: `{ field path → the api_version that introduced it }`.
// v1 introduced everything at 1, so this map is EMPTY — but the check runs, so
// the day a field lands at vocabulary 2 the refusal ("<field> requires
// api_version >= 2") is already wired. Injectable for exactly that reason.
export const FIELD_VOCABULARY: Readonly<Record<string, number>> = {};

// ── closed enums (z.enum so the vocabulary is declared once and typed) ───────

export const runtimeKindSchema = z.enum(['in-process', 'command', 'worker']);
export type RuntimeKind = z.infer<typeof runtimeKindSchema>;

export const overlayTargetSchema = z.enum(['session', 'node']);
export const overlayTypeSchema = z.enum(['enum', 'scalar']);
export const paneKindSchema = z.enum(['blocks', 'pty']);
export const paneScopeSchema = z.enum(['project', 'node', 'session']);
export const panePlacementSchema = z.enum(['main', 'context', 'sidebar', 'overlay']);
// migration-map §3.4: "a pane that declares neither is a manifest error, because
// 'gracefully degrading' with no declared degradation is aspiration."
export const paneDegradeSchema = z.enum(['omit', 'link']);
export const eventDeliverSchema = z.enum(['worker', 'command']);
export const isolationSchema = z.enum(['inherit', 'shared', 'worktree']);
export const permissionModeSchema = z.enum(['default', 'plan']);
export const acceptanceKindSchema = z.enum([
  'rubric',
  'scalar',
  'human-gate',
  'artifact',
  'report',
]);
export type AcceptanceKind = z.infer<typeof acceptanceKindSchema>;
// node-kit §1.8.4 (a): the coverage vocabulary, and A-17's nuance pinned
// ("an extra reported id neither blocks nor forces completion").
export const rubricCoverageSchema = z.enum(['all-criteria-pass']);
export const rubricUnlistedIdsSchema = z.enum(['ignore']);
// node-kit §1.8.4 (b): `min` IS the floor rule; v1 has no second aggregate.
export const scalarAggregateSchema = z.enum(['min']);

// ── the result shape ─────────────────────────────────────────────────────────

/** A structured parse issue. `code` is the stable identity; `message` is prose. */
export interface ManifestIssue {
  /** Stable machine identity — what tests and the registry match on. */
  readonly code: string;
  /** Dotted path into the manifest document, e.g. `verbs[2].agent.tool`. */
  readonly path: string;
  /** Human prose. Reworded freely; never matched on. */
  readonly message: string;
}

export type ManifestError = ManifestIssue;
export type ManifestWarning = ManifestIssue;

export interface ParsedRuntime {
  readonly kind: RuntimeKind;
  /** argv, never a shell string. Absent for `in-process`. */
  readonly command?: readonly string[];
  /** Opt in to PATH resolution for argv[0]. Default false. */
  readonly system: boolean;
}

export interface ParsedVerbAgentFace {
  readonly server: string;
  readonly tool: string;
}

export interface ParsedVerbHumanArg {
  readonly name: string;
  readonly required: boolean;
  /** A path into the verb's `input` schema, always `input.<path>`. */
  readonly from: string;
}

export interface ParsedVerbHumanFace {
  readonly command: string;
  readonly args: readonly ParsedVerbHumanArg[];
}

export interface ParsedVerb {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly target: string;
  /** Extension-relative JSON Schema path. NEVER read here (S10-A5). */
  readonly input: string;
  readonly agent?: ParsedVerbAgentFace;
  readonly human?: ParsedVerbHumanFace;
}

export interface ParsedOverlayAttention {
  readonly value: string;
  readonly rank: string;
}

export interface ParsedOverlayBand {
  readonly below?: number;
  readonly above?: number;
  readonly rank: string;
}

export interface ParsedOverlay {
  readonly id: string;
  readonly target: z.infer<typeof overlayTargetSchema>;
  /** The engine namespaces this as `ext.<extension-id>.<key>`. */
  readonly key: string;
  readonly type: z.infer<typeof overlayTypeSchema>;
  readonly values?: readonly string[];
  readonly format?: string;
  readonly attention: readonly ParsedOverlayAttention[];
  readonly bands: readonly ParsedOverlayBand[];
}

export interface ParsedPane {
  readonly id: string;
  readonly title: string;
  readonly kind: z.infer<typeof paneKindSchema>;
  readonly scope: z.infer<typeof paneScopeSchema>;
  readonly placement: z.infer<typeof panePlacementSchema>;
  readonly source: string;
  readonly degrade: z.infer<typeof paneDegradeSchema>;
}

export interface ParsedEventSubscription {
  readonly on: string;
  readonly deliver: z.infer<typeof eventDeliverSchema>;
  readonly command?: readonly string[];
}

/** node-kit §1.2 — the CLOSED mechanics vocabulary a kind bundles. */
export interface NodeProperties {
  readonly attachesSession: boolean;
  readonly terminal: boolean;
  readonly dispatchOnEntry: { readonly enabled: boolean; readonly by: readonly ProposerClass[] };
  readonly isolation: z.infer<typeof isolationSchema>;
  readonly permissionMode: z.infer<typeof permissionModeSchema>;
  readonly attention?: string;
}

export interface ParsedNodeKind extends NodeProperties {
  readonly id: string;
}

export interface ParsedBriefing {
  readonly composer: string;
  readonly inputs: readonly string[];
  readonly tools: readonly string[];
  readonly permissionMode?: z.infer<typeof permissionModeSchema>;
  readonly capture: readonly string[];
}

export interface ParsedAcceptance {
  readonly kind: AcceptanceKind;
  readonly report?: string;
  readonly criteriaFrom?: string;
  readonly coverage?: string;
  readonly unlistedIds?: string;
  readonly dimensions?: readonly string[];
  readonly aggregate?: string;
  readonly threshold?: number;
  readonly evidenceRequired?: boolean;
  readonly prompt?: string;
  readonly requires?: readonly string[];
  readonly onPass?: string;
  readonly onFail?: string;
  readonly onAnswer?: Readonly<Record<string, string>>;
}

export interface ParsedWorkflowNode {
  readonly id: string;
  readonly kind: string;
  readonly title?: string;
  /** The kind's bundle with this node's overrides applied. */
  readonly properties: NodeProperties;
  readonly briefing?: ParsedBriefing;
  readonly acceptance?: ParsedAcceptance;
}

/**
 * One row of the legality table, ALWAYS EXPANDED (node-kit §1.4.3: "a wildcard
 * row is expanded at parse time and listed expanded, so the inspectable
 * artifact is still the full table"). `declaredFrom`/`declaredTo` keep the row
 * a reviewer wrote, so the listing can show both.
 */
export interface ParsedEdge {
  readonly from: string;
  readonly to: string;
  readonly by: readonly ProposerClass[];
  readonly maxTraversals?: number;
  readonly onExhausted?: string;
  readonly declaredFrom: string;
  readonly declaredTo: string;
}

/** node-kit §1.4.4 — an absent edge refuses `illegal-edge`; a FORBIDDEN edge carries its own reason. */
export interface ParsedForbiddenEdge {
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}

export interface ParsedWorkflow {
  readonly id: string;
  readonly title: string;
  readonly initial: string;
  /** Extension-relative JSON Schema for the instance payload. NEVER read here. */
  readonly record?: string;
  readonly nodes: readonly ParsedWorkflowNode[];
  /** The EXPANDED table. */
  readonly edges: readonly ParsedEdge[];
  readonly forbidden: readonly ParsedForbiddenEdge[];
}

export interface ParsedManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: number;
  readonly description?: string;
  readonly vimesVersion?: string;
  readonly capabilities: readonly string[];
  readonly runtime: ParsedRuntime;
  readonly verbs: readonly ParsedVerb[];
  readonly overlays: readonly ParsedOverlay[];
  readonly panes: readonly ParsedPane[];
  readonly events: readonly ParsedEventSubscription[];
  readonly nodeKinds: readonly ParsedNodeKind[];
  readonly workflows: readonly ParsedWorkflow[];
}

export type ParseManifestResult =
  | { readonly ok: true; readonly manifest: ParsedManifest; readonly warnings: readonly ManifestWarning[] }
  | { readonly ok: false; readonly errors: readonly ManifestError[]; readonly warnings: readonly ManifestWarning[] };

export interface ParseManifestOptions {
  /** Defaults to `API_VERSION`. Injected so the too-new refusal is testable. */
  readonly hostApiVersion?: number;
  /** Defaults to `FIELD_VOCABULARY` (empty in v1). Injected so §2.3's per-field gate is testable. */
  readonly fieldVocabulary?: Readonly<Record<string, number>>;
  /** Defaults to `DEPRECATED_CAPABILITIES` (empty in v1). Injected so §5.3 rule 3 is testable. */
  readonly deprecatedCapabilities?: Readonly<Record<string, string>>;
}

// ── grammar helpers (extension-model §2.2, herdr's `normalize_identifier`) ───

const ID_MAX_LENGTH = 120;
/** herdr's id grammar verbatim: ASCII alnum + `:` `.` `_` `-`. */
const ID_CHARSET = /^[A-Za-z0-9:._-]+$/;
/**
 * herdr's LOCAL-id grammar: the same charset minus `.`, because the engine
 * composes qualified names with dots (`vimes-tasks.promote`) and a dot inside a
 * local id makes that composition ambiguous (§2.2).
 */
const LOCAL_ID_CHARSET = /^[A-Za-z0-9:_-]+$/;

/** The official semver.org grammar. §2.2: non-semver `version` is a parse error, not a warning. */
const SEMVER_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

export function isSemver(value: string): boolean {
  return SEMVER_RE.test(value);
}

// A comparator over a possibly-partial version: `>=0.9`, `<2`, `^1.2.3`, `~1.2`.
const RANGE_COMPARATOR = String.raw`(?:[<>]=?|=|\^|~)?\s*(?:\d+(?:\.\d+)?(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?|\*)`;
const RANGE_CHUNK_RE = new RegExp(`^\\s*${RANGE_COMPARATOR}(?:\\s+${RANGE_COMPARATOR})*\\s*$`);

/**
 * §2.2 `vimes_version`: a semver RANGE over the daemon's own version. Only the
 * SYNTAX is validated here — resolving a range against a running daemon is an
 * activation-time question (§2.3) and needs a version this pure module is not
 * given.
 */
export function isSemverRange(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return trimmed
    .split('||')
    .every((alternative) =>
      alternative
        .split(',')
        .every((chunk) => chunk.trim().length > 0 && RANGE_CHUNK_RE.test(chunk)),
    );
}

// ── the issue collector ──────────────────────────────────────────────────────

class IssueCollector {
  readonly errors: ManifestIssue[] = [];
  readonly warnings: ManifestIssue[] = [];

  error(code: string, path: string, message: string): void {
    this.errors.push({ code, path, message });
  }

  warn(code: string, path: string, message: string): void {
    this.warnings.push({ code, path, message });
  }
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

// ── scalar field readers (each records its own structured refusal) ───────────

function readString(
  collector: IssueCollector,
  table: Record<string, unknown>,
  key: string,
  path: string,
  options: { required: boolean },
): string | undefined {
  const raw = table[key];
  if (raw === undefined) {
    if (options.required) {
      collector.error('field-missing', path, `\`${key}\` is required.`);
    }
    return undefined;
  }
  if (typeof raw !== 'string') {
    collector.error('field-type', path, `\`${key}\` must be a string.`);
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    if (options.required) {
      collector.error('field-empty', path, `\`${key}\` must be non-empty after trim.`);
    }
    // §2.2: an empty-after-trim optional string is DROPPED, not an error.
    return undefined;
  }
  return trimmed;
}

function readEnum<T extends string>(
  collector: IssueCollector,
  table: Record<string, unknown>,
  key: string,
  path: string,
  schema: z.ZodEnum<[T, ...T[]]>,
  options: { required: boolean },
): T | undefined {
  const raw = readString(collector, table, key, path, options);
  if (raw === undefined) return undefined;
  const result = schema.safeParse(raw);
  if (!result.success) {
    collector.error(
      'field-not-in-vocabulary',
      path,
      `\`${key}\` must be one of ${schema.options.map((o) => `"${o}"`).join(', ')}; got "${raw}".`,
    );
    return undefined;
  }
  return result.data;
}

function readBoolean(
  collector: IssueCollector,
  table: Record<string, unknown>,
  key: string,
  path: string,
  fallback: boolean,
): boolean {
  const raw = table[key];
  if (raw === undefined) return fallback;
  if (typeof raw !== 'boolean') {
    collector.error('field-type', path, `\`${key}\` must be a boolean.`);
    return fallback;
  }
  return raw;
}

function readStringArray(
  collector: IssueCollector,
  table: Record<string, unknown>,
  key: string,
  path: string,
  options: { required: boolean; allowEmpty: boolean },
): string[] | undefined {
  const raw = table[key];
  if (raw === undefined) {
    if (options.required) {
      collector.error('field-missing', path, `\`${key}\` is required.`);
    }
    return undefined;
  }
  if (!Array.isArray(raw)) {
    collector.error('field-type', path, `\`${key}\` must be an array of strings.`);
    return undefined;
  }
  if (raw.length === 0 && !options.allowEmpty) {
    collector.error('field-empty', path, `\`${key}\` must not be empty.`);
    return undefined;
  }
  const values: string[] = [];
  let clean = true;
  raw.forEach((element, index) => {
    if (typeof element !== 'string' || element.trim().length === 0) {
      collector.error(
        'field-type',
        `${path}[${index}]`,
        `every element of \`${key}\` must be a non-empty string.`,
      );
      clean = false;
      return;
    }
    values.push(element.trim());
  });
  return clean ? values : undefined;
}

/** §2.2's identity grammar, applied to both the extension id and section-local ids. */
function validateId(
  collector: IssueCollector,
  value: string,
  path: string,
  variant: 'global' | 'local',
): void {
  if (value.length > ID_MAX_LENGTH) {
    collector.error(
      'id-too-long',
      path,
      `an id is at most ${ID_MAX_LENGTH} characters; got ${value.length}.`,
    );
  }
  const charset = variant === 'global' ? ID_CHARSET : LOCAL_ID_CHARSET;
  if (!charset.test(value)) {
    collector.error(
      'id-charset',
      path,
      variant === 'global'
        ? `an id may contain only ASCII alphanumerics and \`: . _ -\`; got "${value}".`
        : `a section-local id may contain only ASCII alphanumerics and \`: _ -\` (no \`.\`, because the engine composes qualified names with dots); got "${value}".`,
    );
  }
}

/** §2.2 (herdr): duplicate ids within a section are a HARD error. */
function checkDuplicateIds(
  collector: IssueCollector,
  ids: readonly (string | undefined)[],
  sectionPath: string,
): void {
  const seen = new Set<string>();
  ids.forEach((id, index) => {
    if (id === undefined) return;
    if (seen.has(id)) {
      collector.error(
        'duplicate-id',
        `${sectionPath}[${index}].id`,
        `duplicate id "${id}" in \`${sectionPath}\` — ids must be unique within a section.`,
      );
      return;
    }
    seen.add(id);
  });
}

/** Warn (never refuse) on a key the vocabulary does not know — herdr's forward-compatible degrade. */
function warnUnknownKeys(
  collector: IssueCollector,
  table: Record<string, unknown>,
  known: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(table)) {
    if (!known.includes(key)) {
      collector.warn(
        'unknown-field',
        `${path}.${key}`,
        `\`${key}\` is not part of api_version ${API_VERSION}'s vocabulary here; it is ignored.`,
      );
    }
  }
}

/**
 * node-kit §1.2: "a property the engine does not recognise is a manifest error,
 * exactly as an unknown capability is — a node kind is the one place where
 * 'degrade quietly' would mean running work under mechanics nobody declared."
 */
function refuseUnknownKeys(
  collector: IssueCollector,
  table: Record<string, unknown>,
  known: readonly string[],
  path: string,
  code: string,
  what: string,
): void {
  for (const key of Object.keys(table)) {
    if (!known.includes(key)) {
      collector.error(
        code,
        `${path}.${key}`,
        `\`${key}\` is not a recognised ${what}; the vocabulary is CLOSED (node-kit §1.2), so an unrecognised property is refused rather than ignored.`,
      );
    }
  }
}

// ── §2.3's permissive api_version pre-parse ──────────────────────────────────

/**
 * §2.3 property 1: "a too-new manifest fails with 'upgrade vimes', not parse
 * noise." AoE pre-parses `api_version` permissively BEFORE deserializing the
 * document (`manifest.rs:889-896`); this is that, over the raw text.
 *
 * Scans only the leading bare-key region — everything before the first table
 * header — because that is where TOML binds a top-level key (§2.1's ordering
 * hazard). A tolerant integer match on purpose: it must survive a document the
 * real parser rejects.
 */
export function preParseApiVersion(text: string): number | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) return undefined; // first table header: bare-key region is over
    const match = /^api_version\s*=\s*([0-9_]+)\s*(?:#.*)?$/.exec(trimmed);
    const digits = match?.[1];
    if (digits !== undefined) {
      const parsed = Number.parseInt(digits.replace(/_/g, ''), 10);
      return Number.isNaN(parsed) ? undefined : parsed;
    }
  }
  return undefined;
}

// ── §2.1's top-level-keys-before-tables hazard ───────────────────────────────

/**
 * §2.1, stated as a load-bearing ordering rule: "TOML binds bare keys to the
 * most recently opened table, so `capabilities` after [runtime] would silently
 * become `runtime.capabilities`."
 *
 * The failure is quiet — the manifest parses, the key is simply gone from where
 * it was meant to be — so it gets a TARGETED refusal naming the hazard rather
 * than a bare "`capabilities` is required".
 *
 * Only keys that are never legal inside a section are checked, so a match is
 * unambiguous. (`description`/`title`/`id` are legal section keys and would
 * make this check lie.)
 */
const HAZARD_PRONE_TOP_LEVEL_KEYS: readonly string[] = [
  'capabilities',
  'api_version',
  'vimes_version',
  'version',
];

function detectTopLevelBindingHazard(
  collector: IssueCollector,
  document: Record<string, unknown>,
): void {
  const searchTargets: { path: string; table: Record<string, unknown> }[] = [];
  const runtime = document.runtime;
  if (isTable(runtime)) searchTargets.push({ path: 'runtime', table: runtime });
  for (const section of ['verbs', 'overlays', 'panes', 'events', 'node-kinds', 'workflows']) {
    const value = document[section];
    if (!Array.isArray(value)) continue;
    value.forEach((element, index) => {
      if (isTable(element)) searchTargets.push({ path: `${section}[${index}]`, table: element });
    });
  }

  for (const key of HAZARD_PRONE_TOP_LEVEL_KEYS) {
    if (document[key] !== undefined) continue;
    for (const target of searchTargets) {
      if (target.table[key] === undefined) continue;
      collector.error(
        'top-level-key-bound-to-table',
        `${target.path}.${key}`,
        `\`${key}\` is a TOP-LEVEL key but was found inside \`${target.path}\`, and it is absent at the top level. TOML binds a bare key to the most recently opened table (extension-model §2.1), so a \`${key} = …\` line written AFTER a table header silently becomes \`${target.path}.${key}\`. Move it above every table header.`,
      );
      break;
    }
  }
}

// ── §2.3's per-field vocabulary gate ─────────────────────────────────────────

/** Every field path present in the document, arrays collapsed to `[]`. */
function collectFieldPaths(value: unknown, prefix: string, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const element of value) collectFieldPaths(element, `${prefix}[]`, out);
    return;
  }
  if (!isTable(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const path = prefix.length === 0 ? key : `${prefix}.${key}`;
    out.add(path);
    collectFieldPaths(child, path, out);
  }
}

/**
 * §2.3: "a field introduced at vocabulary 3 present in a manifest declaring
 * api_version = 1 is refused with `<field> requires api_version >= 3`."
 *
 * v1 introduced everything at 1 so the default map is empty and this loop does
 * nothing — but it RUNS, so the mechanism is live rather than promised.
 */
function checkFieldVocabulary(
  collector: IssueCollector,
  document: Record<string, unknown>,
  declaredApiVersion: number,
  vocabulary: Readonly<Record<string, number>>,
): void {
  const entries = Object.entries(vocabulary);
  if (entries.length === 0) return;
  const present = new Set<string>();
  collectFieldPaths(document, '', present);
  for (const [field, introducedAt] of entries) {
    if (!present.has(field)) continue;
    if (declaredApiVersion >= introducedAt) continue;
    collector.error(
      'field-requires-newer-api-version',
      field,
      `\`${field}\` requires api_version >= ${introducedAt}, but this manifest declares api_version = ${declaredApiVersion}.`,
    );
  }
}

// ── section parsers ──────────────────────────────────────────────────────────

const RUNTIME_KEYS = ['kind', 'command', 'system'];

function parseRuntime(
  collector: IssueCollector,
  document: Record<string, unknown>,
): ParsedRuntime | undefined {
  const raw = document.runtime;
  if (raw === undefined) {
    collector.error('field-missing', 'runtime', '`[runtime]` is required.');
    return undefined;
  }
  if (!isTable(raw)) {
    collector.error('field-type', 'runtime', '`[runtime]` must be a table.');
    return undefined;
  }
  warnUnknownKeys(collector, raw, RUNTIME_KEYS, 'runtime');

  const kind = readEnum(collector, raw, 'kind', 'runtime.kind', runtimeKindSchema, {
    required: true,
  });
  const system = readBoolean(collector, raw, 'system', 'runtime.system', false);

  // §2.1/§2.3: argv, never a shell string — argv[0] is extension-relative
  // unless `system` opts into PATH resolution. A string here is the classic
  // shell-injection shape and is refused by name rather than by type noise.
  let command: string[] | undefined;
  const rawCommand = raw.command;
  if (typeof rawCommand === 'string') {
    collector.error(
      'runtime-command-not-argv',
      'runtime.command',
      '`command` is an argv ARRAY, never a shell string — VIMES never hands a runtime command to a shell.',
    );
  } else if (rawCommand !== undefined) {
    command = readStringArray(collector, raw, 'command', 'runtime.command', {
      required: false,
      allowEmpty: false,
    });
  }

  if (kind === 'in-process') {
    // §1.2/§2.3: Tier 1 IS the daemon build; there is no process to spawn.
    if (rawCommand !== undefined) {
      collector.error(
        'runtime-command-forbidden',
        'runtime.command',
        '`command` is forbidden for `kind = "in-process"` — a Tier-1 module is TypeScript inside the daemon build, so there is nothing to spawn.',
      );
    }
  } else if (kind !== undefined && rawCommand === undefined) {
    collector.error(
      'runtime-command-required',
      'runtime.command',
      `\`command\` (argv) is required for \`kind = "${kind}"\` — a Tier-2 extension is reached by spawning it.`,
    );
  }

  if (kind === undefined) return undefined;
  return { kind, command, system };
}

const VERB_KEYS = ['id', 'title', 'description', 'target', 'input', 'agent', 'human'];
const VERB_AGENT_KEYS = ['server', 'tool'];
const VERB_HUMAN_KEYS = ['command', 'args'];
const VERB_HUMAN_ARG_KEYS = ['name', 'required', 'from'];

/**
 * §1.8.2 / node-kit q14 (D71): `offered_when` was RETIRED. Its presence is an
 * error rather than an ignored key, because a manifest carrying it is a
 * manifest whose author believes exposure is a predicate — and silently
 * dropping the field would silently change which tools a session is offered.
 */
function refuseOfferedWhen(
  collector: IssueCollector,
  table: Record<string, unknown>,
  path: string,
): void {
  if (table.offered_when === undefined) return;
  collector.error(
    'offered-when-retired',
    `${path}.offered_when`,
    '`offered_when` was RETIRED (node-kit §1.8.2, D71/q14): there is no exposure predicate and there never needs to be one. A DISPATCHED session gets the tools its node declared (`[workflows.nodes.briefing].tools`); a standing entity or human client gets the verbs it was GRANTED (D56). Express the same fact as one of those two.',
  );
}

function parseVerbs(collector: IssueCollector, document: Record<string, unknown>): ParsedVerb[] {
  const raw = document.verbs;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    collector.error('field-type', 'verbs', '`[[verbs]]` must be an array of tables.');
    return [];
  }

  const verbs: ParsedVerb[] = [];
  const ids: (string | undefined)[] = [];

  raw.forEach((element, index) => {
    const path = `verbs[${index}]`;
    if (!isTable(element)) {
      collector.error('field-type', path, 'every `[[verbs]]` entry must be a table.');
      ids.push(undefined);
      return;
    }
    warnUnknownKeys(collector, element, VERB_KEYS, path);
    refuseOfferedWhen(collector, element, path);

    const id = readString(collector, element, 'id', `${path}.id`, { required: true });
    if (id !== undefined) validateId(collector, id, `${path}.id`, 'local');
    ids.push(id);

    const title = readString(collector, element, 'title', `${path}.title`, { required: true });
    const description = readString(collector, element, 'description', `${path}.description`, {
      required: false,
    });
    const target = readString(collector, element, 'target', `${path}.target`, { required: true });
    if (target !== undefined) {
      validateId(collector, target, `${path}.target`, 'local');
      // §2.4 + node-kit §1.7: an extension RECORD kind is a legal target, so an
      // unrecognised one is a forward reference we cannot disprove — WARN.
      if (!ENGINE_VERB_TARGETS.includes(target)) {
        collector.warn(
          'verb-target-not-engine-kind',
          `${path}.target`,
          `"${target}" is not one of the engine object kinds (${ENGINE_VERB_TARGETS.join(', ')}). api_version ${API_VERSION} enforces \`target\` at invocation, so this only resolves if it names an extension record kind.`,
        );
      }
    }
    // The path is NAMED here and READ in Move 1b — S10-A5 keeps this module off
    // the filesystem.
    const input = readString(collector, element, 'input', `${path}.input`, { required: true });

    let agent: ParsedVerbAgentFace | undefined;
    const rawAgent = element.agent;
    if (rawAgent !== undefined) {
      if (!isTable(rawAgent)) {
        collector.error('field-type', `${path}.agent`, '`agent` must be a table.');
      } else {
        warnUnknownKeys(collector, rawAgent, VERB_AGENT_KEYS, `${path}.agent`);
        refuseOfferedWhen(collector, rawAgent, `${path}.agent`);
        // §2.4: the family name is ENGINE-owned (the exposure matrix's units,
        // D65); the tool name is the extension's inside that family.
        const server = readString(collector, rawAgent, 'server', `${path}.agent.server`, {
          required: true,
        });
        const tool = readString(collector, rawAgent, 'tool', `${path}.agent.tool`, {
          required: true,
        });
        if (server !== undefined && tool !== undefined) agent = { server, tool };
      }
    }

    let human: ParsedVerbHumanFace | undefined;
    const rawHuman = element.human;
    if (rawHuman !== undefined) {
      if (!isTable(rawHuman)) {
        collector.error('field-type', `${path}.human`, '`human` must be a table.');
      } else {
        warnUnknownKeys(collector, rawHuman, VERB_HUMAN_KEYS, `${path}.human`);
        refuseOfferedWhen(collector, rawHuman, `${path}.human`);
        const command = readString(collector, rawHuman, 'command', `${path}.human.command`, {
          required: true,
        });
        const args: ParsedVerbHumanArg[] = [];
        const rawArgs = rawHuman.args;
        if (rawArgs !== undefined) {
          if (!Array.isArray(rawArgs)) {
            collector.error('field-type', `${path}.human.args`, '`args` must be an array of tables.');
          } else {
            rawArgs.forEach((argElement, argIndex) => {
              const argPath = `${path}.human.args[${argIndex}]`;
              if (!isTable(argElement)) {
                collector.error('field-type', argPath, 'every `args` entry must be a table.');
                return;
              }
              warnUnknownKeys(collector, argElement, VERB_HUMAN_ARG_KEYS, argPath);
              const name = readString(collector, argElement, 'name', `${argPath}.name`, {
                required: true,
              });
              const required = readBoolean(collector, argElement, 'required', `${argPath}.required`, false);
              const from = readString(collector, argElement, 'from', `${argPath}.from`, {
                required: true,
              });
              if (from !== undefined) validateArgFromPath(collector, from, `${argPath}.from`);
              if (name !== undefined && from !== undefined) args.push({ name, required, from });
            });
          }
        }
        if (command !== undefined) human = { command, args };
      }
    }

    // §2.4: both faces are optional individually, but a verb nobody can invoke
    // is not a verb.
    if (rawAgent === undefined && rawHuman === undefined) {
      collector.error(
        'verb-no-face',
        path,
        'a verb must declare at least one face — `[verbs.agent]` (the agent tool) or `[verbs.human]` (the human command).',
      );
    }

    if (id !== undefined && title !== undefined && target !== undefined && input !== undefined) {
      verbs.push({ id, title, description, target, input, agent, human });
    }
  });

  checkDuplicateIds(collector, ids, 'verbs');
  return verbs;
}

/**
 * §2.4 rule 1, THE MANIFEST-LEVEL HALF (see `RESERVED_AUTHORITY_PROPERTIES`).
 * An arg's `from` is a path into the verb's `input` schema; if its LEAF names a
 * reserved authority property, the verb is offering a payload field that claims
 * the decision already happened — which is #13's exact violation.
 */
function validateArgFromPath(collector: IssueCollector, from: string, path: string): void {
  if (!from.startsWith('input.') || from.length <= 'input.'.length) {
    collector.error(
      'arg-from-not-input-path',
      path,
      `\`from\` must be a path into the verb's \`input\` schema, written \`input.<path>\`; got "${from}". Both faces share ONE input schema (§2.4 rule 2).`,
    );
    return;
  }
  const segments = from.slice('input.'.length).split('.');
  const leaf = segments[segments.length - 1] ?? '';
  if (RESERVED_AUTHORITY_PROPERTIES.includes(leaf)) {
    collector.error(
      'reserved-authority-property',
      path,
      `"${leaf}" is a RESERVED AUTHORITY PROPERTY (${RESERVED_AUTHORITY_PROPERTIES.join(', ')}). Authority is never carried in a payload (§2.4 rule 1, principle 13): the engine stamps the proposer from the channel the invocation arrived on. A verb that accepts "${leaf}" is asking the caller to declare its own authority.`,
    );
  }
}

const OVERLAY_KEYS = ['id', 'target', 'key', 'type', 'values', 'format', 'attention', 'bands'];

function parseOverlays(
  collector: IssueCollector,
  document: Record<string, unknown>,
): ParsedOverlay[] {
  const raw = document.overlays;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    collector.error('field-type', 'overlays', '`[[overlays]]` must be an array of tables.');
    return [];
  }

  const overlays: ParsedOverlay[] = [];
  const ids: (string | undefined)[] = [];

  raw.forEach((element, index) => {
    const path = `overlays[${index}]`;
    if (!isTable(element)) {
      collector.error('field-type', path, 'every `[[overlays]]` entry must be a table.');
      ids.push(undefined);
      return;
    }
    warnUnknownKeys(collector, element, OVERLAY_KEYS, path);

    const id = readString(collector, element, 'id', `${path}.id`, { required: true });
    if (id !== undefined) validateId(collector, id, `${path}.id`, 'local');
    ids.push(id);

    const target = readEnum(collector, element, 'target', `${path}.target`, overlayTargetSchema, {
      required: true,
    });
    // §2.5: the engine namespaces the key as `ext.<id>.<key>`, so extensions
    // cannot collide with each other or with engine fields.
    const key = readString(collector, element, 'key', `${path}.key`, { required: true });
    if (key !== undefined) validateId(collector, key, `${path}.key`, 'local');
    const type = readEnum(collector, element, 'type', `${path}.type`, overlayTypeSchema, {
      required: true,
    });

    let values: string[] | undefined;
    let format: string | undefined;
    const attention: ParsedOverlayAttention[] = [];
    const bands: ParsedOverlayBand[] = [];

    if (type === 'enum') {
      values = readStringArray(collector, element, 'values', `${path}.values`, {
        required: true,
        allowEmpty: false,
      });
      if (values !== undefined && new Set(values).size !== values.length) {
        collector.error(
          'overlay-values-not-unique',
          `${path}.values`,
          'an enum overlay\'s `values` must be unique — a closed value vocabulary with a repeat is not closed.',
        );
      }
      if (element.bands !== undefined) {
        collector.error(
          'overlay-bands-on-enum',
          `${path}.bands`,
          '`bands` map NUMERIC bands onto attention ranks and belong to `type = "scalar"`; an enum overlay uses `attention` instead (§2.5).',
        );
      }
      parseOverlayAttention(collector, element, path, values ?? [], attention);
    } else if (type === 'scalar') {
      // §2.5: a scalar is "a number with a display `format` and optional `bands`".
      format = readString(collector, element, 'format', `${path}.format`, { required: true });
      if (element.values !== undefined) {
        collector.error(
          'overlay-values-on-scalar',
          `${path}.values`,
          '`values` declare a closed enum vocabulary and belong to `type = "enum"`.',
        );
      }
      if (element.attention !== undefined) {
        collector.error(
          'overlay-attention-on-scalar',
          `${path}.attention`,
          '`attention` maps enum VALUES onto ranks; a scalar overlay maps numeric `bands` instead (§2.5).',
        );
      }
      parseOverlayBands(collector, element, path, bands);
    }

    if (id !== undefined && target !== undefined && key !== undefined && type !== undefined) {
      overlays.push({ id, target, key, type, values, format, attention, bands });
    }
  });

  checkDuplicateIds(collector, ids, 'overlays');
  return overlays;
}

/**
 * §2.5's deliberate degrade-BREAK: "an unknown event kind merely means a hook
 * never fires; an unknown attention rank means the rollup is wrong while
 * looking right. Loud beats degraded exactly when silence is the failure mode."
 * So this is a HARD ERROR, not a warning, and that asymmetry is the point.
 */
function validateAttentionRank(collector: IssueCollector, rank: string, path: string): void {
  if (KNOWN_ATTENTION_RANKS.includes(rank)) return;
  collector.error(
    'unknown-attention-rank',
    path,
    `"${rank}" is not a declared attention rank. E2-b's total order is authoritative and an overlay may only CLAIM an existing rank (§2.5); the declared ranks are ${KNOWN_ATTENTION_RANKS.join(', ')}. Unlike an unknown event kind this is a hard error, because a misordered rollup looks right while being wrong.`,
  );
}

function parseOverlayAttention(
  collector: IssueCollector,
  element: Record<string, unknown>,
  path: string,
  values: readonly string[],
  out: ParsedOverlayAttention[],
): void {
  const raw = element.attention;
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    collector.error('field-type', `${path}.attention`, '`attention` must be an array of tables.');
    return;
  }
  raw.forEach((entry, index) => {
    const entryPath = `${path}.attention[${index}]`;
    if (!isTable(entry)) {
      collector.error('field-type', entryPath, 'every `attention` entry must be a table.');
      return;
    }
    warnUnknownKeys(collector, entry, ['value', 'rank'], entryPath);
    const value = readString(collector, entry, 'value', `${entryPath}.value`, { required: true });
    const rank = readString(collector, entry, 'rank', `${entryPath}.rank`, { required: true });
    if (value !== undefined && values.length > 0 && !values.includes(value)) {
      collector.error(
        'overlay-attention-unknown-value',
        `${entryPath}.value`,
        `"${value}" is not one of this overlay's declared \`values\`.`,
      );
    }
    if (rank !== undefined) validateAttentionRank(collector, rank, `${entryPath}.rank`);
    if (value !== undefined && rank !== undefined) out.push({ value, rank });
  });
}

function parseOverlayBands(
  collector: IssueCollector,
  element: Record<string, unknown>,
  path: string,
  out: ParsedOverlayBand[],
): void {
  const raw = element.bands;
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    collector.error('field-type', `${path}.bands`, '`bands` must be an array of tables.');
    return;
  }
  raw.forEach((entry, index) => {
    const entryPath = `${path}.bands[${index}]`;
    if (!isTable(entry)) {
      collector.error('field-type', entryPath, 'every `bands` entry must be a table.');
      return;
    }
    warnUnknownKeys(collector, entry, ['below', 'above', 'rank'], entryPath);
    const below = entry.below;
    const above = entry.above;
    if (below !== undefined && typeof below !== 'number') {
      collector.error('field-type', `${entryPath}.below`, '`below` must be a number.');
    }
    if (above !== undefined && typeof above !== 'number') {
      collector.error('field-type', `${entryPath}.above`, '`above` must be a number.');
    }
    if (below === undefined && above === undefined) {
      collector.error(
        'band-no-bound',
        entryPath,
        'a band must declare `below` or `above` — a band with no bound claims a rank unconditionally.',
      );
    }
    const rank = readString(collector, entry, 'rank', `${entryPath}.rank`, { required: true });
    if (rank !== undefined) validateAttentionRank(collector, rank, `${entryPath}.rank`);
    if (rank !== undefined) {
      out.push({
        below: typeof below === 'number' ? below : undefined,
        above: typeof above === 'number' ? above : undefined,
        rank,
      });
    }
  });
}

const PANE_KEYS = ['id', 'title', 'kind', 'scope', 'placement', 'source', 'degrade'];

function parsePanes(collector: IssueCollector, document: Record<string, unknown>): ParsedPane[] {
  const raw = document.panes;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    collector.error('field-type', 'panes', '`[[panes]]` must be an array of tables.');
    return [];
  }

  const panes: ParsedPane[] = [];
  const ids: (string | undefined)[] = [];

  raw.forEach((element, index) => {
    const path = `panes[${index}]`;
    if (!isTable(element)) {
      collector.error('field-type', path, 'every `[[panes]]` entry must be a table.');
      ids.push(undefined);
      return;
    }
    warnUnknownKeys(collector, element, PANE_KEYS, path);

    const id = readString(collector, element, 'id', `${path}.id`, { required: true });
    if (id !== undefined) validateId(collector, id, `${path}.id`, 'local');
    ids.push(id);

    const title = readString(collector, element, 'title', `${path}.title`, { required: true });
    const kind = readEnum(collector, element, 'kind', `${path}.kind`, paneKindSchema, {
      required: true,
    });
    const scope = readEnum(collector, element, 'scope', `${path}.scope`, paneScopeSchema, {
      required: true,
    });
    const placement = readEnum(
      collector,
      element,
      'placement',
      `${path}.placement`,
      panePlacementSchema,
      { required: true },
    );
    const source = readString(collector, element, 'source', `${path}.source`, { required: true });
    // migration-map §3.4: undeclared degradation is a manifest error, because
    // "gracefully degrading" with no declared degradation is aspiration.
    const degrade = readEnum(collector, element, 'degrade', `${path}.degrade`, paneDegradeSchema, {
      required: true,
    });

    if (
      id !== undefined &&
      title !== undefined &&
      kind !== undefined &&
      scope !== undefined &&
      placement !== undefined &&
      source !== undefined &&
      degrade !== undefined
    ) {
      panes.push({ id, title, kind, scope, placement, source, degrade });
    }
  });

  checkDuplicateIds(collector, ids, 'panes');
  return panes;
}

const EVENT_KEYS = ['on', 'deliver', 'command'];

function parseEvents(
  collector: IssueCollector,
  document: Record<string, unknown>,
  runtime: ParsedRuntime | undefined,
): ParsedEventSubscription[] {
  const raw = document.events;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    collector.error('field-type', 'events', '`[[events]]` must be an array of tables.');
    return [];
  }

  const events: ParsedEventSubscription[] = [];

  raw.forEach((element, index) => {
    const path = `events[${index}]`;
    if (!isTable(element)) {
      collector.error('field-type', path, 'every `[[events]]` entry must be a table.');
      return;
    }
    warnUnknownKeys(collector, element, EVENT_KEYS, path);

    const on = readString(collector, element, 'on', `${path}.on`, { required: true });
    if (on !== undefined) {
      const replacement = DEPRECATED_EVENT_KINDS[on];
      if (replacement !== undefined) {
        // §4.2 q8's own near-miss, caught by the allowlist carrying deprecation
        // state: a subscription to a zero-producer kind waits forever.
        collector.warn(
          'deprecated-event-kind',
          `${path}.on`,
          `"${on}" is DEPRECATED and has zero producers — a subscription to it never fires. Subscribe to "${replacement}" instead.`,
        );
      } else if (!ENGINE_EVENT_KINDS.includes(on)) {
        // §2.6: herdr's forward-compatible degrade. A manifest written for a
        // newer engine still loads; the hook that cannot fire says so.
        collector.warn(
          'unknown-event-kind',
          `${path}.on`,
          `"${on}" is not an event kind this engine emits, so this hook will never fire. The extension still loads (§2.6) and the unfirable hook is listed.`,
        );
      }
    }

    const deliver = readEnum(collector, element, 'deliver', `${path}.deliver`, eventDeliverSchema, {
      required: true,
    });

    let command: string[] | undefined;
    if (deliver === 'command') {
      // §2.6: `deliver = "command"` spawns argv per event (herdr's shape).
      // (§2.6 also calls this Tier-2 only; that is an ACTIVATION posture, not a
      // parse rule, so it is named here and not enforced here.)
      command = readStringArray(collector, element, 'command', `${path}.command`, {
        required: true,
        allowEmpty: false,
      });
    } else if (deliver === 'worker') {
      if (element.command !== undefined) {
        collector.warn(
          'unknown-field',
          `${path}.command`,
          '`command` is only used by `deliver = "command"`; it is ignored here.',
        );
      }
      // §2.6: worker delivery calls the module's handler at Tier 1 or the
      // supervised worker at Tier 2 — a `command`-kind runtime has neither.
      if (runtime !== undefined && runtime.kind === 'command') {
        collector.error(
          'event-worker-without-worker-runtime',
          `${path}.deliver`,
          '`deliver = "worker"` needs a `[runtime].kind` of "worker" (the supervised process) or "in-process" (the Tier-1 handler); a "command" runtime has no standing recipient.',
        );
      }
    }

    if (on !== undefined && deliver !== undefined) events.push({ on, deliver, command });
  });

  return events;
}

// ── the node kit (node-kit §1) ───────────────────────────────────────────────

// node-kit §1.2 — the CLOSED mechanics vocabulary.
const NODE_PROPERTY_KEYS = [
  'attaches_session',
  'terminal',
  'dispatch_on_entry',
  'isolation',
  'permission_mode',
  'attention',
];
const NODE_KIND_KEYS = ['id', ...NODE_PROPERTY_KEYS];
// A workflow node names a kind, may title itself, may override any kind
// property, and may carry a briefing and an acceptance. Nothing else.
const WORKFLOW_NODE_KEYS = ['id', 'kind', 'title', 'briefing', 'acceptance', ...NODE_PROPERTY_KEYS];

/** node-kit §1.2: "every field is optional with a FAIL-CLOSED default." */
const FAIL_CLOSED_NODE_PROPERTIES: NodeProperties = {
  attachesSession: false,
  terminal: false,
  dispatchOnEntry: { enabled: false, by: [] },
  isolation: 'inherit',
  permissionMode: 'default',
  attention: undefined,
};

function readProposerClasses(
  collector: IssueCollector,
  table: Record<string, unknown>,
  key: string,
  path: string,
  options: { required: boolean },
): ProposerClass[] | undefined {
  const values = readStringArray(collector, table, key, path, {
    required: options.required,
    allowEmpty: true,
  });
  if (values === undefined) return undefined;
  const classes: ProposerClass[] = [];
  let clean = true;
  values.forEach((value, index) => {
    const result = proposerClassSchema.safeParse(value);
    if (!result.success) {
      // node-kit q17 (D71). Matched positively everywhere — the negated form
      // "reads identically today and fails open tomorrow"
      // (`dispatchDecision.ts:99`).
      collector.error(
        'unknown-proposer-class',
        `${path}[${index}]`,
        `"${value}" is not a proposer class. The engine stamps the proposer from the channel a proposal arrived on; the vocabulary is ${proposerClassSchema.options.join(' | ')} (node-kit q17).`,
      );
      clean = false;
      return;
    }
    classes.push(result.data);
  });
  if (!clean) return undefined;
  if (new Set(classes).size !== classes.length) {
    collector.error('duplicate-proposer-class', path, 'a proposer class is listed twice.');
    return undefined;
  }
  return classes;
}

/** Reads the node-kind property bundle out of a table, layered over `base`. */
function readNodeProperties(
  collector: IssueCollector,
  table: Record<string, unknown>,
  path: string,
  base: NodeProperties,
): NodeProperties {
  const attachesSession = readBoolean(
    collector,
    table,
    'attaches_session',
    `${path}.attaches_session`,
    base.attachesSession,
  );
  const terminal = readBoolean(collector, table, 'terminal', `${path}.terminal`, base.terminal);

  let dispatchOnEntry = base.dispatchOnEntry;
  const rawDispatch = table.dispatch_on_entry;
  if (rawDispatch !== undefined) {
    if (!isTable(rawDispatch)) {
      collector.error(
        'field-type',
        `${path}.dispatch_on_entry`,
        '`dispatch_on_entry` must be a table, e.g. `{ enabled = true, by = ["human"] }`.',
      );
    } else {
      refuseUnknownKeys(
        collector,
        rawDispatch,
        ['enabled', 'by'],
        `${path}.dispatch_on_entry`,
        'unknown-node-property',
        '`dispatch_on_entry` property',
      );
      const enabled = readBoolean(
        collector,
        rawDispatch,
        'enabled',
        `${path}.dispatch_on_entry.enabled`,
        false,
      );
      // node-kit §1.5: BOTH halves are needed — D53's rule is not "does this
      // node dispatch" but "does this node dispatch WHEN ENTERED THIS WAY".
      const by =
        rawDispatch.by === undefined
          ? []
          : (readProposerClasses(
              collector,
              rawDispatch,
              'by',
              `${path}.dispatch_on_entry.by`,
              { required: false },
            ) ?? []);
      dispatchOnEntry = { enabled, by };
    }
  }

  const isolation =
    readEnum(collector, table, 'isolation', `${path}.isolation`, isolationSchema, {
      required: false,
    }) ?? base.isolation;
  const permissionMode =
    readEnum(collector, table, 'permission_mode', `${path}.permission_mode`, permissionModeSchema, {
      required: false,
    }) ?? base.permissionMode;

  let attention = base.attention;
  const rawAttention = readString(collector, table, 'attention', `${path}.attention`, {
    required: false,
  });
  if (rawAttention !== undefined) {
    validateAttentionRank(collector, rawAttention, `${path}.attention`);
    attention = rawAttention;
  }

  return { attachesSession, terminal, dispatchOnEntry, isolation, permissionMode, attention };
}

function parseNodeKinds(
  collector: IssueCollector,
  document: Record<string, unknown>,
): ParsedNodeKind[] {
  const raw = document['node-kinds'];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    collector.error('field-type', 'node-kinds', '`[[node-kinds]]` must be an array of tables.');
    return [];
  }

  const kinds: ParsedNodeKind[] = [];
  const ids: (string | undefined)[] = [];

  raw.forEach((element, index) => {
    const path = `node-kinds[${index}]`;
    if (!isTable(element)) {
      collector.error('field-type', path, 'every `[[node-kinds]]` entry must be a table.');
      ids.push(undefined);
      return;
    }
    // node-kit §1.2: unknown PROPERTY is an error, never a warning.
    refuseUnknownKeys(
      collector,
      element,
      NODE_KIND_KEYS,
      path,
      'unknown-node-property',
      'node-kind property',
    );

    const id = readString(collector, element, 'id', `${path}.id`, { required: true });
    if (id !== undefined) validateId(collector, id, `${path}.id`, 'local');
    ids.push(id);

    const properties = readNodeProperties(collector, element, path, FAIL_CLOSED_NODE_PROPERTIES);
    if (id !== undefined) kinds.push({ id, ...properties });
  });

  checkDuplicateIds(collector, ids, 'node-kinds');
  return kinds;
}

const BRIEFING_KEYS = ['composer', 'inputs', 'tools', 'permission_mode', 'capture'];

/**
 * node-kit §1.8.1: "the INPUTS are the security surface." A CLOSED allow-list
 * from a closed vocabulary of input kinds — the engine hands the composer these
 * and nothing else, so a reader of the manifest can see what a node's performer
 * can possibly have been given. Denial is the complement of the allow-list;
 * there is no `withhold` field, because a deny-list is unfalsifiable.
 */
function validateBriefingInput(collector: IssueCollector, input: string, path: string): void {
  if (input === 'instance.record') return;
  if (input.startsWith('artifact:')) {
    if (input.slice('artifact:'.length).length === 0) {
      collector.error('briefing-input-empty-reference', path, '`artifact:` needs an artifact id.');
    }
    return;
  }
  if (input.startsWith('report:')) {
    if (input.slice('report:'.length).length === 0) {
      collector.error('briefing-input-empty-reference', path, '`report:` needs a report kind.');
    }
    return;
  }
  if (input.startsWith('capture:')) {
    validateCaptureName(collector, input.slice('capture:'.length), path);
    return;
  }
  // Anything else must be a plain extension-relative path. A `:` here means an
  // unknown prefix, which is the failure this closed vocabulary exists to catch.
  if (input.includes(':')) {
    collector.error(
      'briefing-input-unknown-prefix',
      path,
      `"${input}" uses an unknown input prefix. The vocabulary is CLOSED: \`instance.record\`, \`artifact:<id>\`, \`report:<id>\`, \`capture:<name>\`, or a plain extension-relative path (node-kit §1.8.1).`,
    );
    return;
  }
  if (input.startsWith('/') || input.split('/').includes('..')) {
    collector.error(
      'briefing-input-escapes-extension',
      path,
      `"${input}" must be an EXTENSION-RELATIVE path — an absolute path or a \`..\` segment reaches outside the extension's own tree.`,
    );
  }
}

function validateCaptureName(collector: IssueCollector, name: string, path: string): void {
  if (CAPTURE_CATALOGUE.includes(name)) return;
  collector.error(
    'unknown-capture-name',
    path,
    `"${name}" is not in the engine's interception catalogue (${CAPTURE_CATALOGUE.join(', ')}). The catalogue is engine surface and CLOSED: an extension may opt into an interception, it may never add one (node-kit §1.8.3).`,
  );
}

function parseBriefing(
  collector: IssueCollector,
  element: Record<string, unknown>,
  path: string,
): ParsedBriefing | undefined {
  const raw = element.briefing;
  if (raw === undefined) return undefined;
  if (!isTable(raw)) {
    collector.error('field-type', `${path}.briefing`, '`briefing` must be a table.');
    return undefined;
  }
  const briefingPath = `${path}.briefing`;
  refuseUnknownKeys(
    collector,
    raw,
    BRIEFING_KEYS,
    briefingPath,
    'unknown-briefing-property',
    'briefing property',
  );

  // node-kit §1.8.1: "the prose is code." The composer is an extension entry
  // point; only its NAME is declarative.
  const composer = readString(collector, raw, 'composer', `${briefingPath}.composer`, {
    required: true,
  });
  const inputs =
    readStringArray(collector, raw, 'inputs', `${briefingPath}.inputs`, {
      required: false,
      allowEmpty: true,
    }) ?? [];
  inputs.forEach((input, index) =>
    validateBriefingInput(collector, input, `${briefingPath}.inputs[${index}]`),
  );

  const tools =
    readStringArray(collector, raw, 'tools', `${briefingPath}.tools`, {
      required: false,
      allowEmpty: true,
    }) ?? [];

  const permissionMode = readEnum(
    collector,
    raw,
    'permission_mode',
    `${briefingPath}.permission_mode`,
    permissionModeSchema,
    { required: false },
  );

  const capture =
    readStringArray(collector, raw, 'capture', `${briefingPath}.capture`, {
      required: false,
      allowEmpty: true,
    }) ?? [];
  capture.forEach((name, index) =>
    validateCaptureName(collector, name, `${briefingPath}.capture[${index}]`),
  );

  if (composer === undefined) return undefined;
  return { composer, inputs, tools, permissionMode, capture };
}

// node-kit §1.8.4 — six alternative bodies for ONE acceptance table; a node
// declares exactly one of them.
const ACCEPTANCE_KEYS_BY_KIND: Readonly<Record<AcceptanceKind, readonly string[]>> = {
  rubric: ['kind', 'report', 'criteria_from', 'coverage', 'unlisted_ids', 'on_pass', 'on_fail'],
  scalar: [
    'kind',
    'report',
    'dimensions',
    'aggregate',
    'threshold',
    'evidence_required',
    'on_pass',
    'on_fail',
  ],
  'human-gate': ['kind', 'prompt', 'on_answer'],
  artifact: ['kind', 'requires', 'on_pass', 'on_fail'],
  report: ['kind', 'report', 'on_pass', 'on_fail'],
};

function parseAcceptance(
  collector: IssueCollector,
  element: Record<string, unknown>,
  path: string,
): ParsedAcceptance | undefined {
  const raw = element.acceptance;
  // node-kit §1.8.4 (f) NONE: the table is absent entirely — the node rests and
  // something proposes the move.
  if (raw === undefined) return undefined;
  if (!isTable(raw)) {
    collector.error('field-type', `${path}.acceptance`, '`acceptance` must be a table.');
    return undefined;
  }
  const acceptancePath = `${path}.acceptance`;
  const kind = readEnum(collector, raw, 'kind', `${acceptancePath}.kind`, acceptanceKindSchema, {
    required: true,
  });
  if (kind === undefined) return undefined;

  refuseUnknownKeys(
    collector,
    raw,
    ACCEPTANCE_KEYS_BY_KIND[kind],
    acceptancePath,
    'unknown-acceptance-property',
    `\`kind = "${kind}"\` acceptance property`,
  );

  const onPass = readString(collector, raw, 'on_pass', `${acceptancePath}.on_pass`, {
    required: false,
  });
  const onFail = readString(collector, raw, 'on_fail', `${acceptancePath}.on_fail`, {
    required: false,
  });

  const acceptance: {
    kind: AcceptanceKind;
    report?: string;
    criteriaFrom?: string;
    coverage?: string;
    unlistedIds?: string;
    dimensions?: string[];
    aggregate?: string;
    threshold?: number;
    evidenceRequired?: boolean;
    prompt?: string;
    requires?: string[];
    onPass?: string;
    onFail?: string;
    onAnswer?: Record<string, string>;
  } = { kind, onPass, onFail };

  if (kind === 'rubric') {
    acceptance.report = readString(collector, raw, 'report', `${acceptancePath}.report`, {
      required: true,
    });
    acceptance.criteriaFrom = readString(
      collector,
      raw,
      'criteria_from',
      `${acceptancePath}.criteria_from`,
      { required: true },
    );
    acceptance.coverage = readEnum(
      collector,
      raw,
      'coverage',
      `${acceptancePath}.coverage`,
      rubricCoverageSchema,
      { required: true },
    );
    // A-17: the coverage nuance pinned in the vocabulary "or it changes
    // behaviour silently".
    acceptance.unlistedIds = readEnum(
      collector,
      raw,
      'unlisted_ids',
      `${acceptancePath}.unlisted_ids`,
      rubricUnlistedIdsSchema,
      { required: false },
    );
  } else if (kind === 'scalar') {
    acceptance.report = readString(collector, raw, 'report', `${acceptancePath}.report`, {
      required: true,
    });
    const dimensions = readStringArray(
      collector,
      raw,
      'dimensions',
      `${acceptancePath}.dimensions`,
      { required: true, allowEmpty: false },
    );
    if (dimensions !== undefined && new Set(dimensions).size !== dimensions.length) {
      collector.error(
        'acceptance-dimensions-not-unique',
        `${acceptancePath}.dimensions`,
        '`dimensions` must be unique.',
      );
    }
    acceptance.dimensions = dimensions;
    acceptance.aggregate = readEnum(
      collector,
      raw,
      'aggregate',
      `${acceptancePath}.aggregate`,
      scalarAggregateSchema,
      { required: true },
    );
    // node-kit §1.8.4 property 3: a threshold is EXTENSION CONTENT, not an
    // engine ⟨tune⟩ — rule 0.2 binds engine bands, not a tenant's bar.
    const threshold = raw.threshold;
    if (threshold === undefined) {
      collector.error('field-missing', `${acceptancePath}.threshold`, '`threshold` is required.');
    } else if (typeof threshold !== 'number') {
      collector.error('field-type', `${acceptancePath}.threshold`, '`threshold` must be a number.');
    } else {
      acceptance.threshold = threshold;
    }
    acceptance.evidenceRequired = readBoolean(
      collector,
      raw,
      'evidence_required',
      `${acceptancePath}.evidence_required`,
      false,
    );
  } else if (kind === 'human-gate') {
    acceptance.prompt = readString(collector, raw, 'prompt', `${acceptancePath}.prompt`, {
      required: true,
    });
    const rawOnAnswer = raw.on_answer;
    if (rawOnAnswer === undefined) {
      collector.error('field-missing', `${acceptancePath}.on_answer`, '`on_answer` is required.');
    } else if (!isTable(rawOnAnswer)) {
      collector.error(
        'field-type',
        `${acceptancePath}.on_answer`,
        '`on_answer` must be a table mapping each answer to a declared node.',
      );
    } else {
      const onAnswer: Record<string, string> = {};
      for (const [answer, target] of Object.entries(rawOnAnswer)) {
        if (typeof target !== 'string' || target.trim().length === 0) {
          collector.error(
            'field-type',
            `${acceptancePath}.on_answer.${answer}`,
            'every `on_answer` value must be a declared node id.',
          );
          continue;
        }
        onAnswer[answer] = target.trim();
      }
      acceptance.onAnswer = onAnswer;
    }
  } else if (kind === 'artifact') {
    const requires = readStringArray(collector, raw, 'requires', `${acceptancePath}.requires`, {
      required: true,
      allowEmpty: false,
    });
    requires?.forEach((requirement, index) => {
      // §1.8.3: "a captured artifact satisfies an `artifact` acceptance through
      // the reserved `capture:<name>` reference."
      if (requirement.startsWith('capture:')) {
        validateCaptureName(
          collector,
          requirement.slice('capture:'.length),
          `${acceptancePath}.requires[${index}]`,
        );
      }
    });
    acceptance.requires = requires;
  } else {
    // report — the degenerate case of rubric, and D53's "outcomes are reports":
    // satisfied by the EXISTENCE of a schema-valid report, never by judging it.
    acceptance.report = readString(collector, raw, 'report', `${acceptancePath}.report`, {
      required: true,
    });
  }

  return acceptance;
}

const WORKFLOW_KEYS = ['id', 'title', 'initial', 'record', 'nodes', 'edges', 'forbidden'];
const EDGE_KEYS = [
  'from',
  'to',
  'by',
  'max_traversals',
  'on_exhausted',
  'except_from',
  'except_to',
];
const FORBIDDEN_KEYS = ['from', 'to', 'reason'];

interface DeclaredEdge {
  readonly from: string;
  readonly to: string;
  readonly by: readonly ProposerClass[];
  readonly maxTraversals?: number;
  readonly onExhausted?: string;
  readonly exceptFrom: readonly string[];
  readonly exceptTo: readonly string[];
  readonly path: string;
}

function parseDeclaredEdges(
  collector: IssueCollector,
  workflowTable: Record<string, unknown>,
  workflowPath: string,
): DeclaredEdge[] {
  const raw = workflowTable.edges;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    collector.error(
      'field-type',
      `${workflowPath}.edges`,
      '`edges` must be an array of tables (either `edges = [ {…}, … ]` or a run of `[[workflows.edges]]` headers — node-kit §1.4 says they are the same data).',
    );
    return [];
  }

  const edges: DeclaredEdge[] = [];
  raw.forEach((element, index) => {
    const path = `${workflowPath}.edges[${index}]`;
    if (!isTable(element)) {
      collector.error('field-type', path, 'every edge must be a table.');
      return;
    }
    refuseUnknownKeys(collector, element, EDGE_KEYS, path, 'unknown-edge-property', 'edge property');

    const from = readString(collector, element, 'from', `${path}.from`, { required: true });
    const to = readString(collector, element, 'to', `${path}.to`, { required: true });
    const by = readProposerClasses(collector, element, 'by', `${path}.by`, { required: true });
    if (by !== undefined && by.length === 0) {
      collector.error(
        'edge-no-proposer',
        `${path}.by`,
        '`by` must name at least one proposer class — an edge nobody may propose is an edge that does not exist.',
      );
    }

    let maxTraversals: number | undefined;
    const rawMax = element.max_traversals;
    if (rawMax !== undefined) {
      if (!isInteger(rawMax) || rawMax < 1) {
        collector.error(
          'edge-max-traversals-invalid',
          `${path}.max_traversals`,
          '`max_traversals` must be a positive integer — the counter is engine-owned (node-kit §1.4.2).',
        );
      } else {
        maxTraversals = rawMax;
      }
    }

    const onExhausted = readString(collector, element, 'on_exhausted', `${path}.on_exhausted`, {
      required: false,
    });
    if (onExhausted !== undefined && maxTraversals === undefined && rawMax === undefined) {
      collector.error(
        'edge-on-exhausted-without-bound',
        `${path}.on_exhausted`,
        '`on_exhausted` names where an EXHAUSTED bounded loop routes, so it needs `max_traversals`.',
      );
    }

    const exceptFrom =
      readStringArray(collector, element, 'except_from', `${path}.except_from`, {
        required: false,
        allowEmpty: false,
      }) ?? [];
    const exceptTo =
      readStringArray(collector, element, 'except_to', `${path}.except_to`, {
        required: false,
        allowEmpty: false,
      }) ?? [];

    if (element.except_from !== undefined && from !== '*') {
      collector.error(
        'edge-except-without-wildcard',
        `${path}.except_from`,
        '`except_from` subtracts from a `from = "*"` expansion; it means nothing on an explicit source.',
      );
    }
    if (element.except_to !== undefined && to !== '*') {
      collector.error(
        'edge-except-without-wildcard',
        `${path}.except_to`,
        '`except_to` subtracts from a `to = "*"` expansion; it means nothing on an explicit target.',
      );
    }

    if (from === undefined || to === undefined || by === undefined) return;
    edges.push({ from, to, by, maxTraversals, onExhausted, exceptFrom, exceptTo, path });
  });

  return edges;
}

/**
 * node-kit §1.4.3 — wildcard expansion, at parse time, listed expanded.
 *
 * "**Expansion never yields a self-edge (`from == to`)**, and this is a
 * parse-time property rather than a runtime one: self-moves are refused by the
 * `same-node` precedence rule regardless, but a wildcard that expanded into
 * `cancelled → cancelled` would put a phantom edge in the LISTED table, and the
 * listing is the artifact a reviewer reads."
 */
function expandEdges(
  collector: IssueCollector,
  declared: readonly DeclaredEdge[],
  nodeIds: readonly string[],
  workflowPath: string,
): ParsedEdge[] {
  const expanded = new Map<string, ParsedEdge>();

  for (const edge of declared) {
    const sources = edge.from === '*' ? nodeIds.filter((n) => !edge.exceptFrom.includes(n)) : [edge.from];
    const targets = edge.to === '*' ? nodeIds.filter((n) => !edge.exceptTo.includes(n)) : [edge.to];

    for (const from of sources) {
      for (const to of targets) {
        // THE self-edge exclusion. Only wildcard fallout is silently dropped; a
        // hand-written self-edge is a declared mistake and is refused below.
        if (from === to) {
          if (edge.from !== '*' && edge.to !== '*') {
            collector.error(
              'edge-self-loop',
              edge.path,
              `an edge may not name the same node on both ends ("${from}") — a self-move is refused by the \`same-node\` precedence rule regardless.`,
            );
          }
          continue;
        }
        // A NUL separator, written as an ESCAPE rather than as a raw byte:
        // node ids are validated local-ids (no NUL is reachable), so this key
        // cannot collide however the ids are punctuated. Spelling it \u0000
        // keeps the SOURCE text byte-clean — a literal NUL here makes grep,
        // blame and diff classify this whole file as binary (found at the
        // S10·Move-1a gate). Do not "simplify" it to a raw byte.
        const key = `${from}\u0000${to}`;
        const row: ParsedEdge = {
          from,
          to,
          by: edge.by,
          maxTraversals: edge.maxTraversals,
          onExhausted: edge.onExhausted,
          declaredFrom: edge.from,
          declaredTo: edge.to,
        };
        const existing = expanded.get(key);
        if (existing === undefined) {
          expanded.set(key, row);
          continue;
        }
        // Two rows produced one edge. Identical rows are the honest cost of
        // overlapping wildcards (in the tasks workflow `blocked-external →
        // cancelled` arrives from BOTH the park's `to = "*"` and the cancel
        // wildcard) — deduped, and WARNED so the overlap is visible in the
        // listing rather than invisible in the table.
        const sameBy =
          existing.by.length === row.by.length && existing.by.every((b, i) => row.by[i] === b);
        if (
          sameBy &&
          existing.maxTraversals === row.maxTraversals &&
          existing.onExhausted === row.onExhausted
        ) {
          collector.warn(
            'edge-duplicate-expansion',
            edge.path,
            `\`${from} → ${to}\` is produced by more than one declared row (here by \`${edge.from} → ${edge.to}\`); the rows agree, so the edge is listed once.`,
          );
        } else {
          collector.error(
            'edge-conflicting-expansion',
            edge.path,
            `\`${from} → ${to}\` is produced by two declared rows that DISAGREE (proposers / bound / exhaustion target). A legality table with two answers for one edge has no answer.`,
          );
        }
      }
    }
  }

  return [...expanded.values()].sort((a, b) =>
    a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from),
  );
}

function parseWorkflows(
  collector: IssueCollector,
  document: Record<string, unknown>,
  nodeKinds: readonly ParsedNodeKind[],
): ParsedWorkflow[] {
  const raw = document.workflows;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    collector.error('field-type', 'workflows', '`[[workflows]]` must be an array of tables.');
    return [];
  }

  const workflows: ParsedWorkflow[] = [];
  const workflowIds: (string | undefined)[] = [];
  const kindsById = new Map(nodeKinds.map((kind) => [kind.id, kind]));

  raw.forEach((element, index) => {
    const path = `workflows[${index}]`;
    if (!isTable(element)) {
      collector.error('field-type', path, 'every `[[workflows]]` entry must be a table.');
      workflowIds.push(undefined);
      return;
    }
    refuseUnknownKeys(
      collector,
      element,
      WORKFLOW_KEYS,
      path,
      'unknown-workflow-property',
      'workflow property',
    );

    const id = readString(collector, element, 'id', `${path}.id`, { required: true });
    if (id !== undefined) validateId(collector, id, `${path}.id`, 'local');
    workflowIds.push(id);
    const title = readString(collector, element, 'title', `${path}.title`, { required: true });
    const initial = readString(collector, element, 'initial', `${path}.initial`, { required: true });
    // NAMED, never read — the registry validates instance payloads against it.
    const record = readString(collector, element, 'record', `${path}.record`, { required: false });

    const nodes = parseWorkflowNodes(collector, element, path, kindsById);
    const nodeIds = nodes.map((node) => node.id);
    const nodeIdSet = new Set(nodeIds);

    const declaredEdges = parseDeclaredEdges(collector, element, path);
    // Every non-wildcard endpoint must name a declared node — including the
    // wildcard rows' `except_*` subtractions, which silently do nothing when
    // they name a node that is not there.
    for (const edge of declaredEdges) {
      if (edge.from !== '*' && !nodeIdSet.has(edge.from)) {
        collector.error(
          'unknown-node-reference',
          `${edge.path}.from`,
          `"${edge.from}" is not a declared node of workflow "${id ?? '?'}".`,
        );
      }
      if (edge.to !== '*' && !nodeIdSet.has(edge.to)) {
        collector.error(
          'unknown-node-reference',
          `${edge.path}.to`,
          `"${edge.to}" is not a declared node of workflow "${id ?? '?'}".`,
        );
      }
      for (const excepted of [...edge.exceptFrom, ...edge.exceptTo]) {
        if (!nodeIdSet.has(excepted)) {
          collector.error(
            'unknown-node-reference',
            edge.path,
            `\`except_*\` names "${excepted}", which is not a declared node — an exception that subtracts nothing silently widens the table.`,
          );
        }
      }
      if (edge.onExhausted !== undefined && !nodeIdSet.has(edge.onExhausted)) {
        collector.error(
          'unknown-node-reference',
          `${edge.path}.on_exhausted`,
          `\`on_exhausted\` names "${edge.onExhausted}", which is not a declared node.`,
        );
      }
    }

    const edges = expandEdges(collector, declaredEdges, nodeIds, path);
    const forbidden = parseForbiddenEdges(collector, element, path, nodeIdSet, id);

    if (initial !== undefined && !nodeIdSet.has(initial)) {
      collector.error(
        'unknown-node-reference',
        `${path}.initial`,
        `\`initial\` names "${initial}", which is not a declared node.`,
      );
    }

    // Acceptance routing targets are part of the graph, not decoration.
    for (const node of nodes) {
      const nodePath = `${path}.nodes[${nodeIds.indexOf(node.id)}].acceptance`;
      const targets: [string, string | undefined][] = [
        ['on_pass', node.acceptance?.onPass],
        ['on_fail', node.acceptance?.onFail],
      ];
      for (const [field, target] of targets) {
        if (target !== undefined && !nodeIdSet.has(target)) {
          collector.error(
            'unknown-node-reference',
            `${nodePath}.${field}`,
            `\`${field}\` names "${target}", which is not a declared node.`,
          );
        }
      }
      for (const [answer, target] of Object.entries(node.acceptance?.onAnswer ?? {})) {
        if (!nodeIdSet.has(target)) {
          collector.error(
            'unknown-node-reference',
            `${nodePath}.on_answer.${answer}`,
            `\`on_answer.${answer}\` names "${target}", which is not a declared node.`,
          );
        }
      }
    }

    if (initial !== undefined && nodeIdSet.has(initial)) {
      checkReachability(collector, path, initial, nodes, edges, declaredEdges);
    }

    if (id !== undefined && title !== undefined && initial !== undefined) {
      workflows.push({ id, title, initial, record, nodes, edges, forbidden });
    }
  });

  checkDuplicateIds(collector, workflowIds, 'workflows');
  return workflows;
}

function parseWorkflowNodes(
  collector: IssueCollector,
  workflowTable: Record<string, unknown>,
  workflowPath: string,
  kindsById: ReadonlyMap<string, ParsedNodeKind>,
): ParsedWorkflowNode[] {
  const raw = workflowTable.nodes;
  if (raw === undefined) {
    collector.error(
      'field-missing',
      `${workflowPath}.nodes`,
      'a workflow must declare at least one `[[workflows.nodes]]`.',
    );
    return [];
  }
  if (!Array.isArray(raw)) {
    collector.error(
      'field-type',
      `${workflowPath}.nodes`,
      '`[[workflows.nodes]]` must be an array of tables.',
    );
    return [];
  }

  const nodes: ParsedWorkflowNode[] = [];
  const ids: (string | undefined)[] = [];

  raw.forEach((element, index) => {
    const path = `${workflowPath}.nodes[${index}]`;
    if (!isTable(element)) {
      collector.error('field-type', path, 'every `[[workflows.nodes]]` entry must be a table.');
      ids.push(undefined);
      return;
    }
    // node-kit §1.3: "any [[node-kinds]] property may be overridden here;
    // nothing else may appear."
    refuseUnknownKeys(
      collector,
      element,
      WORKFLOW_NODE_KEYS,
      path,
      'unknown-node-property',
      'workflow-node property',
    );

    const id = readString(collector, element, 'id', `${path}.id`, { required: true });
    if (id !== undefined) validateId(collector, id, `${path}.id`, 'local');
    ids.push(id);

    const kind = readString(collector, element, 'kind', `${path}.kind`, { required: true });
    let base = FAIL_CLOSED_NODE_PROPERTIES;
    if (kind !== undefined) {
      const declaredKind = kindsById.get(kind);
      if (declaredKind === undefined) {
        collector.error(
          'unknown-node-kind',
          `${path}.kind`,
          `"${kind}" is not a declared \`[[node-kinds]]\` id. Kind NAMES are open, but a node composes a bundle the manifest declared (node-kit §1.1).`,
        );
      } else {
        const { id: _kindId, ...properties } = declaredKind;
        base = properties;
      }
    }

    const title = readString(collector, element, 'title', `${path}.title`, { required: false });
    const properties = readNodeProperties(collector, element, path, base);
    const briefing = parseBriefing(collector, element, path);
    const acceptance = parseAcceptance(collector, element, path);

    // ⚠ THE ONE CROSS-DECLARATION RULE IN THE KIT (node-kit §2's migration
    // hazard, q16). D55 exists BECAUSE plan mode gates MCP tools: an offered
    // tool under plan mode fires a human gate, and an unattended planner then
    // waits forever. A node declaring both has rebuilt that stall.
    const effectivePermissionMode = briefing?.permissionMode ?? properties.permissionMode;
    if (effectivePermissionMode === 'plan' && (briefing?.tools.length ?? 0) > 0) {
      collector.error(
        'plan-mode-with-tools',
        `${path}.briefing.tools`,
        `\`permission_mode = "plan"\` with a non-empty \`tools\` list rebuilds D55's OBSERVED incident: plan mode gates MCP tools, an offered tool fires a human gate, and an unattended planner then waits forever. Declare no tools on a plan-mode node (node-kit §2's migration hazard, q16).`,
      );
    }

    if (id !== undefined && kind !== undefined) {
      nodes.push({ id, kind, title, properties, briefing, acceptance });
    }
  });

  checkDuplicateIds(collector, ids, `${workflowPath}.nodes`);
  return nodes;
}

function parseForbiddenEdges(
  collector: IssueCollector,
  workflowTable: Record<string, unknown>,
  workflowPath: string,
  nodeIdSet: ReadonlySet<string>,
  workflowId: string | undefined,
): ParsedForbiddenEdge[] {
  const raw = workflowTable.forbidden;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    collector.error(
      'field-type',
      `${workflowPath}.forbidden`,
      '`forbidden` must be an array of tables.',
    );
    return [];
  }

  const forbidden: ParsedForbiddenEdge[] = [];
  raw.forEach((element, index) => {
    const path = `${workflowPath}.forbidden[${index}]`;
    if (!isTable(element)) {
      collector.error('field-type', path, 'every `forbidden` entry must be a table.');
      return;
    }
    refuseUnknownKeys(
      collector,
      element,
      FORBIDDEN_KEYS,
      path,
      'unknown-forbidden-property',
      'forbidden-edge property',
    );
    const from = readString(collector, element, 'from', `${path}.from`, { required: true });
    const to = readString(collector, element, 'to', `${path}.to`, { required: true });
    // node-kit §1.4.4: the reason is the refusal the engine RECORDS. An absent
    // edge refuses `illegal-edge`, which is right for a typo and wrong for a
    // safety rule.
    const reason = readString(collector, element, 'reason', `${path}.reason`, { required: true });

    for (const [field, value] of [
      ['from', from],
      ['to', to],
    ] as const) {
      if (value !== undefined && !nodeIdSet.has(value)) {
        collector.error(
          'unknown-node-reference',
          `${path}.${field}`,
          `"${value}" is not a declared node of workflow "${workflowId ?? '?'}".`,
        );
      }
    }

    if (from !== undefined && to !== undefined && reason !== undefined) {
      forbidden.push({ from, to, reason });
    }
  });

  return forbidden;
}

/**
 * node-kit §1.9: "reachability is checked over edges PLUS
 * `on_exhausted`/`on_pass`/`on_fail` targets, or a perfectly correct workflow
 * lists as having an orphan node."
 *
 * `manual-review` is the worked case: it has no in-edge by design, because it
 * is reachable only through `on_exhausted` on the bounded review/fix loop — "a
 * route the engine takes when a proposal is refused, not a move anyone may
 * propose."
 */
function checkReachability(
  collector: IssueCollector,
  workflowPath: string,
  initial: string,
  nodes: readonly ParsedWorkflowNode[],
  edges: readonly ParsedEdge[],
  declaredEdges: readonly DeclaredEdge[],
): void {
  const outgoing = new Map<string, Set<string>>();
  const link = (from: string, to: string): void => {
    let set = outgoing.get(from);
    if (set === undefined) {
      set = new Set<string>();
      outgoing.set(from, set);
    }
    set.add(to);
  };

  for (const edge of edges) link(edge.from, edge.to);
  for (const edge of declaredEdges) {
    if (edge.onExhausted === undefined) continue;
    // An exhausted bounded loop routes out of the loop's SOURCE.
    if (edge.from === '*') {
      for (const node of nodes) link(node.id, edge.onExhausted);
    } else {
      link(edge.from, edge.onExhausted);
    }
  }
  for (const node of nodes) {
    const acceptance = node.acceptance;
    if (acceptance === undefined) continue;
    if (acceptance.onPass !== undefined) link(node.id, acceptance.onPass);
    if (acceptance.onFail !== undefined) link(node.id, acceptance.onFail);
    for (const target of Object.values(acceptance.onAnswer ?? {})) link(node.id, target);
  }

  const reached = new Set<string>([initial]);
  const queue = [initial];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const next of outgoing.get(current) ?? []) {
      if (reached.has(next)) continue;
      reached.add(next);
      queue.push(next);
    }
  }

  nodes.forEach((node, index) => {
    if (reached.has(node.id)) return;
    collector.error(
      'node-unreachable',
      `${workflowPath}.nodes[${index}].id`,
      `"${node.id}" is unreachable from \`initial = "${initial}"\` over the expanded edges plus every \`on_exhausted\` / \`on_pass\` / \`on_fail\` / \`on_answer\` target. A node nothing can reach is a node that does not exist.`,
    );
  });
}

// ── the entry point ──────────────────────────────────────────────────────────

const TOP_LEVEL_KEYS = [
  'id',
  'name',
  'version',
  'api_version',
  'description',
  'vimes_version',
  'capabilities',
  'runtime',
  'verbs',
  'overlays',
  'panes',
  'events',
  'node-kinds',
  'workflows',
];

/**
 * Parse and validate a `vimes-extension.toml`.
 *
 * PURE (S10-A5): text in, result out. Nothing here touches the filesystem, the
 * clock, the network or a random source — which is what makes the whole
 * validation surface assertable headlessly, and what leaves every path this
 * manifest NAMES (`input`, `record`, `source`, `composer`) for the registry to
 * resolve in Move 1b.
 *
 * Never throws: a malformed document is a refusal, exactly as a malformed
 * transition proposal is (`taskStateMachine.ts`'s totality rule).
 */
export function parseExtensionManifest(
  text: string,
  options: ParseManifestOptions = {},
): ParseManifestResult {
  const collector = new IssueCollector();
  const hostApiVersion = options.hostApiVersion ?? API_VERSION;
  const fieldVocabulary = options.fieldVocabulary ?? FIELD_VOCABULARY;
  const deprecatedCapabilities = options.deprecatedCapabilities ?? DEPRECATED_CAPABILITIES;

  // §2.3 property 1 — BEFORE the document is deserialized, so a too-new
  // manifest fails with "upgrade vimes" and not with parse noise.
  const preParsedApiVersion = preParseApiVersion(text);
  if (preParsedApiVersion !== undefined && preParsedApiVersion > hostApiVersion) {
    collector.error(
      'api-version-too-new',
      'api_version',
      `this manifest declares api_version = ${preParsedApiVersion}; this vimes understands api_version up to ${hostApiVersion}. Upgrade vimes.`,
    );
    return { ok: false, errors: collector.errors, warnings: collector.warnings };
  }

  let document: unknown;
  try {
    document = parseToml(text);
  } catch (error) {
    const where =
      error instanceof TomlError ? ` at line ${error.line}, column ${error.column}` : '';
    collector.error(
      'toml-parse-error',
      '',
      `the manifest is not valid TOML${where}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { ok: false, errors: collector.errors, warnings: collector.warnings };
  }

  if (!isTable(document)) {
    collector.error('toml-parse-error', '', 'the manifest must be a TOML table.');
    return { ok: false, errors: collector.errors, warnings: collector.warnings };
  }

  detectTopLevelBindingHazard(collector, document);
  warnUnknownKeys(collector, document, TOP_LEVEL_KEYS, '');

  // ── identity (§2.2) ────────────────────────────────────────────────────────
  const id = readString(collector, document, 'id', 'id', { required: true });
  if (id !== undefined) validateId(collector, id, 'id', 'global');
  const name = readString(collector, document, 'name', 'name', { required: true });
  const description = readString(collector, document, 'description', 'description', {
    required: false,
  });

  // §2.2: SEMVER-VALIDATED, and deliberately divergent from herdr — "the
  // project declaration pins extensions by version RANGE, and a range cannot be
  // resolved against a version that does not compare."
  const version = readString(collector, document, 'version', 'version', { required: true });
  if (version !== undefined && !isSemver(version)) {
    collector.error(
      'version-not-semver',
      'version',
      `\`version\` must be valid semver; got "${version}". A project declaration pins extensions by semver RANGE, and a range cannot be resolved against a version that does not compare (§2.2).`,
    );
  }

  // §2.2/§2.3: gates host BEHAVIOUR, not manifest shape. Only the RANGE SYNTAX
  // is checkable here — resolving it needs a running daemon (activation-time).
  const vimesVersion = readString(collector, document, 'vimes_version', 'vimes_version', {
    required: false,
  });
  if (vimesVersion !== undefined && !isSemverRange(vimesVersion)) {
    collector.error(
      'vimes-version-not-range',
      'vimes_version',
      `\`vimes_version\` must be a semver RANGE (e.g. ">=0.9, <2"); got "${vimesVersion}".`,
    );
  }

  // ── api_version (§2.2/§2.3) ────────────────────────────────────────────────
  let apiVersion: number | undefined;
  const rawApiVersion = document.api_version;
  if (rawApiVersion === undefined) {
    collector.error('field-missing', 'api_version', '`api_version` is required.');
  } else if (!isInteger(rawApiVersion) || rawApiVersion < 1) {
    collector.error(
      'api-version-invalid',
      'api_version',
      '`api_version` must be an integer >= 1 — it names the manifest VOCABULARY version, not the daemon version.',
    );
  } else if (rawApiVersion > hostApiVersion) {
    collector.error(
      'api-version-too-new',
      'api_version',
      `this manifest declares api_version = ${rawApiVersion}; this vimes understands api_version up to ${hostApiVersion}. Upgrade vimes.`,
    );
  } else {
    apiVersion = rawApiVersion;
    checkFieldVocabulary(collector, document, apiVersion, fieldVocabulary);
  }

  // ── capabilities (§2.7 / §5.3) ─────────────────────────────────────────────
  const capabilities =
    readStringArray(collector, document, 'capabilities', 'capabilities', {
      required: false,
      allowEmpty: true,
    }) ?? [];
  capabilities.forEach((capability, index) => {
    const replacement = deprecatedCapabilities[capability];
    if (replacement !== undefined) {
      // §5.3 rule 3: "a retired capability warns; it never silently no-ops."
      collector.warn(
        'deprecated-capability',
        `capabilities[${index}]`,
        `"${capability}" is DEPRECATED; use "${replacement}" instead. It is listed on the extension record rather than silently no-operating.`,
      );
      return;
    }
    if (KNOWN_CAPABILITIES.includes(capability)) return;
    // §5.3 rule 1, lifted verbatim from AoE: "an unknown capability is rejected
    // at install … never silently granted."
    collector.error(
      'unknown-capability',
      `capabilities[${index}]`,
      `"${capability}" is not a capability this vimes knows, so it is REJECTED rather than silently granted (§5.3 rule 1). Supported: ${KNOWN_CAPABILITIES.join(', ')}. Upgrade vimes.`,
    );
  });
  if (new Set(capabilities).size !== capabilities.length) {
    collector.error(
      'duplicate-capability',
      'capabilities',
      'a capability is requested twice — a grant is a set, not a list.',
    );
  }

  // ── the sections ───────────────────────────────────────────────────────────
  const runtime = parseRuntime(collector, document);
  const verbs = parseVerbs(collector, document);
  const overlays = parseOverlays(collector, document);
  const panes = parsePanes(collector, document);
  const events = parseEvents(collector, document, runtime);
  const nodeKinds = parseNodeKinds(collector, document);
  const workflows = parseWorkflows(collector, document, nodeKinds);

  if (collector.errors.length > 0) {
    return { ok: false, errors: collector.errors, warnings: collector.warnings };
  }

  // Every `?? …` below is unreachable while `errors` is empty: a missing
  // required field always recorded an error above. The fallbacks exist so this
  // module never needs a non-null assertion or a throw.
  const manifest: ParsedManifest = {
    id: id ?? '',
    name: name ?? '',
    version: version ?? '',
    apiVersion: apiVersion ?? hostApiVersion,
    description,
    vimesVersion,
    capabilities,
    runtime: runtime ?? { kind: 'in-process', system: false },
    verbs,
    overlays,
    panes,
    events,
    nodeKinds,
    workflows,
  };

  return { ok: true, manifest, warnings: collector.warnings };
}
