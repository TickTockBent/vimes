// ─── S10·Move-1b (D72) — the extension registry ──────────────────────────────
//
// The I/O half of the seam Move 1a opened. `packages/core/src/extensions/
// manifest.ts` is PURE by construction (S10-A5): TOML text in, result out, and
// it never opens a file — not even the `input` JSON Schema files it can only
// name. This module owns every byte of that I/O, which is why it lives in the
// daemon and takes its filesystem as an injected dependency (rule 0.3).
//
// References, SIGNED (D71) — implemented, not improved:
//   • extension-model §2.8  — the two questions, two files split: what is
//                             INSTALLED (this registry) vs what a project
//                             LOADS (`<project>/.vimes/extensions.toml`).
//   • extension-model §2.10 — re-parse on use, registry as cache, broken
//                             manifest degrades to listed-with-warning.
//   • extension-model §2.4  — rule 1's schema-file half (principle 13).
//   • migration-map §1.8    — this file's placement, by name.
//
// ⚠ **ZERO CONSUMERS, DELIBERATELY.** Nothing in `app.ts` or anywhere else
// calls this module; only its own test file imports it. Slice 10 lands the
// seam with no activation, no routes and no behaviour change (rule 0.5's
// posture carried into build). The day something calls it is a different
// slice's decision, made deliberately.
//
// ── what this module refuses to be ───────────────────────────────────────────
//   • It is not an ACTIVATOR. `resolveForProject` produces a REPORT; it starts
//     nothing, loads no code, grants no capability. Extensions propose, the
//     engine's deterministic core decides — and in v1 the engine decides
//     nothing here because nothing consumes the report yet.
//   • It is not an INSTALLER. D67 pins v1 as first-party-only with no install
//     path, so the installed set is entirely construction-time: in-build
//     entries the daemon build names, plus operator-named local directories.
//   • It is not PERSISTENT. herdr's `plugins.json` machinery (lock file,
//     atomic tmp+rename, corrupt-registry-to-empty-list-with-warning, strict
//     reads on mutation so an update cannot truncate the file —
//     `src/persist/plugin_registry.rs`) is the shape we adopt WHEN there is an
//     install path to write about. Until then a lockfile would be ceremony
//     around a list that cannot change between boots: state is in memory,
//     seeded at construction, and that is the whole story (D67).
//
// ── the load-bearing property: re-parse on use (§2.10) ───────────────────────
// EVERY read path — `list`, `get`, `resolveForProject` — re-reads the manifest
// and re-validates it. Only `enabled` and the source provenance survive from
// the held record. Nothing here can be stale, because nothing here is kept.
// In-build entries take the same path with their compiled-in manifest text:
// same code, no special case, so the degrade behaviour cannot diverge between
// the tier that matters and the tier that is tested.

import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { parse as parseToml, TomlError } from 'smol-toml';
import {
  API_VERSION,
  isSemverRange,
  parseExtensionManifest,
  RESERVED_AUTHORITY_PROPERTIES,
  type ManifestIssue,
  type ParsedManifest,
} from '@vimes/core';

/** §2.8: the file an extension directory is identified by. */
export const MANIFEST_FILENAME = 'vimes-extension.toml';
/** §2.8: the in-repo declaration, relative to a project root. */
export const PROJECT_DECLARATION_SEGMENTS: readonly string[] = ['.vimes', 'extensions.toml'];

// ── the injected filesystem (rule 0.3) ───────────────────────────────────────

/**
 * The whole filesystem surface this module uses. Deliberately ONE method, and
 * deliberately one that distinguishes *absent* from *broken* at the seam
 * rather than by errno-sniffing in the logic above it — the difference decides
 * whether a missing project declaration is an empty activation (it is) or a
 * warning (it is not).
 */
export interface RegistryFileReader {
  /**
   * Resolves the file's utf-8 text, or `null` when the file does not exist.
   * Rejects only on a real I/O failure (a permission error, a directory where
   * a file was expected). Every call site here catches that rejection —
   * S10-A4: a broken installation is listed with its problem named, never a
   * throw and never a silent absence.
   */
  readTextIfExists(absolutePath: string): Promise<string | null>;
}

/** The production reader. The one place in this module that touches real disk. */
export function createNodeFileReader(): RegistryFileReader {
  return {
    async readTextIfExists(absolutePath: string): Promise<string | null> {
      try {
        return await readFile(absolutePath, 'utf8');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // ENOENT is "not installed / not declared"; ENOTDIR is the same fact
        // reached through a non-directory path component.
        if (code === 'ENOENT' || code === 'ENOTDIR') return null;
        throw error;
      }
    },
  };
}

// ── the installed set (D67: construction-time, no install path) ──────────────

export type ExtensionSource =
  /** Tier 1: the extension IS the daemon build (D66 §1.3). */
  | { readonly kind: 'in-build' }
  /** An operator-named directory on this box, absolute. */
  | { readonly kind: 'local-dir'; readonly path: string };

/**
 * A Tier-1 extension the daemon build names. `manifestText` is compiled in and
 * `root` is where its extension-relative files (verb `input` schemas) live in
 * the build tree — so the schema half of §2.4 rule 1 applies to Tier 1 exactly
 * as it applies to Tier 2, with no branch.
 */
export interface InBuildExtension {
  /** The id this entry is REGISTERED under. A manifest that later disagrees is an identity drift. */
  readonly id: string;
  readonly manifestText: string;
  /** Absolute directory the manifest's relative paths resolve against. */
  readonly root: string;
  /** Default true. Preserved across every re-parse (§2.10). */
  readonly enabled?: boolean;
}

/** An operator-named local directory containing `vimes-extension.toml`. */
export interface LocalDirExtension {
  /** Absolute path to the extension directory. */
  readonly path: string;
  /** Default true. Preserved across every re-parse (§2.10). */
  readonly enabled?: boolean;
}

export interface ExtensionRegistryOptions {
  readonly inBuild?: readonly InBuildExtension[];
  readonly localDirs?: readonly LocalDirExtension[];
  /** Defaults to `createNodeFileReader()`. Injected so tests are deterministic. */
  readonly fileReader?: RegistryFileReader;
}

/**
 * One registry record, as of the read that produced it.
 *
 * `id` is `null` for a local directory whose manifest has NEVER parsed — the
 * entry is still listed (S10-A4 forbids a silent absence), it simply has no
 * identity to be listed under yet. `source` always identifies it.
 */
export interface ExtensionRecord {
  readonly id: string | null;
  readonly source: ExtensionSource;
  readonly enabled: boolean;
  /** The parsed-manifest CACHE from THIS read. `null` when the manifest did not parse. */
  readonly manifest: ParsedManifest | null;
  readonly errors: readonly ManifestIssue[];
  readonly warnings: readonly ManifestIssue[];
  /**
   * Enabled, parsed, and error-free. A warning never costs runnability — that
   * asymmetry is §2.10's degrade posture and the reason `errors` and
   * `warnings` are separate channels rather than one severity field.
   */
  readonly runnable: boolean;
}

interface HeldRecord {
  readonly source: ExtensionSource;
  /** The declared root for extension-relative file reads. */
  readonly root: string;
  /** In-build only: the compiled-in manifest text. `null` for a local dir. */
  readonly manifestText: string | null;
  /** SURVIVES every re-parse (§2.10). The only mutable field here. */
  enabled: boolean;
  /**
   * Pinned on the first successful parse and never overwritten. Identity is
   * not allowed to drift under re-parse: an extension directory that starts
   * calling itself something else has become a different extension, and
   * silently following it would move an operator's `enabled` flag and a
   * project's declaration onto code they never named.
   */
  pinnedId: string | null;
}

// ── the project declaration (§2.8) ───────────────────────────────────────────

/** Why a declared entry did not resolve. Machine identity; the message is prose. */
export type UnresolvedReason =
  /** No installed extension carries that id. */
  | 'unknown-extension'
  /** Installed, but this read's manifest did not parse — there is no version to compare. */
  | 'extension-not-loadable'
  /** Installed and parsed, but its version is outside the declared range. */
  | 'version-mismatch'
  /** The declared `version` is not a semver range this engine can resolve. */
  | 'invalid-version-range';

export interface ResolvedExtension {
  readonly id: string;
  /** The declared range, or `undefined` when the declaration pinned none. */
  readonly range?: string;
  /** The INSTALLED version this resolved to. */
  readonly version: string;
  readonly source: ExtensionSource;
  /** `enabled` as the PROJECT declared it. */
  readonly declaredEnabled: boolean;
  /** `enabled` as the REGISTRY holds it. */
  readonly registryEnabled: boolean;
  /**
   * RESERVED, opaque (§2.8): validated against the extension's own settings
   * schema, which is itself reserved (S9·5). The engine never reads inside it.
   */
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface UnresolvedExtension {
  readonly id: string;
  readonly range?: string;
  readonly reason: UnresolvedReason;
  /** Named whenever an installed version exists to name — the point of `version-mismatch`. */
  readonly installedVersion?: string;
  readonly message: string;
}

/**
 * A `[[node]]` block: RESERVED in §2.8 (E3-a's per-node extension loading,
 * "DESIGNED BY NOBODY YET"). Parse-ACCEPTED and surfaced so the shape exists
 * and a declaration carrying one is not rejected; acted on by nothing.
 */
export interface ReservedNodeDeclaration {
  readonly id: string | null;
  readonly extensions: readonly string[];
  readonly reserved: true;
}

/**
 * The result of `resolveForProject`. A REPORT — reading it activates nothing.
 * When activation acquires a consumer it will be the AND of `declaredEnabled`
 * and `registryEnabled` over `resolved`; that decision is not this slice's.
 */
export interface ProjectActivationReport {
  readonly projectRoot: string;
  readonly declarationPath: string;
  /** False when the project declares nothing — an empty activation, NOT an error. */
  readonly present: boolean;
  readonly apiVersion?: number;
  readonly resolved: readonly ResolvedExtension[];
  readonly unresolved: readonly UnresolvedExtension[];
  readonly reservedNodes: readonly ReservedNodeDeclaration[];
  /**
   * Structured, same three-channel shape the parser uses. A malformed
   * declaration lands HERE and yields an empty activation: a broken file in a
   * repo must not take the project's engine surfaces down with it.
   */
  readonly warnings: readonly ManifestIssue[];
}

// ── semver comparison (§2.2/§2.8: a range resolved against an installed version)
//
// Written here rather than pulled in: slice 10 adds exactly one dependency
// (`smol-toml`, in core), and the range grammar this must honour is already
// pinned by the parser's `isSemverRange` — one grammar, two consumers, so a
// second opinion in a package's dialect would be a drift source rather than a
// convenience (principle 9).
//
// ⚠ ONE DELIBERATE SIMPLIFICATION, NAMED: npm additionally excludes a
// prerelease version from a range unless the range itself names a prerelease
// on the same [major, minor, patch] tuple. That rule is NOT implemented —
// prerelease PRECEDENCE is honoured (1.0.0-rc.1 < 1.0.0, per semver.org §11),
// the extra exclusion is not. v1's installed set is first-party (D67) and
// declares release versions; the day a project pins a prerelease range, this
// gets a decision record rather than a quiet extra rule.

interface SemverParts {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Dot-separated prerelease identifiers, or `null` for a release version. */
  readonly prerelease: readonly string[] | null;
}

function parseSemverParts(version: string): SemverParts | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    version.trim(),
  );
  if (match === null) return null;
  const [, rawMajor, rawMinor, rawPatch, rawPrerelease] = match;
  return {
    major: Number(rawMajor),
    minor: Number(rawMinor),
    patch: Number(rawPatch),
    prerelease: rawPrerelease === undefined ? null : rawPrerelease.split('.'),
  };
}

/** semver.org §11 precedence. Returns <0, 0, >0. */
function compareSemver(left: SemverParts, right: SemverParts): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  const leftPre = left.prerelease;
  const rightPre = right.prerelease;
  if (leftPre === null && rightPre === null) return 0;
  // §11.3: a version WITH a prerelease has lower precedence than one without.
  if (leftPre === null) return 1;
  if (rightPre === null) return -1;
  const length = Math.max(leftPre.length, rightPre.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = leftPre[index];
    const rightIdentifier = rightPre[index];
    // §11.4.4: a larger set of fields has higher precedence when all preceding
    // identifiers are equal.
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      const difference = Number(leftIdentifier) - Number(rightIdentifier);
      if (difference !== 0) return difference;
      continue;
    }
    // §11.4.3: numeric identifiers always have lower precedence than alphanumeric.
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    if (leftIdentifier !== rightIdentifier) return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

/** A comparator's operand: a possibly-partial version, or `*`. */
interface PartialVersion {
  readonly major: number;
  readonly minor: number | null;
  readonly patch: number | null;
  readonly prerelease: readonly string[] | null;
}

function parsePartialVersion(text: string): PartialVersion | null {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    text,
  );
  if (match === null) return null;
  const [, rawMajor, rawMinor, rawPatch, rawPrerelease] = match;
  return {
    major: Number(rawMajor),
    minor: rawMinor === undefined ? null : Number(rawMinor),
    patch: rawPatch === undefined ? null : Number(rawPatch),
    prerelease: rawPrerelease === undefined ? null : rawPrerelease.split('.'),
  };
}

function lowerBound(partial: PartialVersion): SemverParts {
  return {
    major: partial.major,
    minor: partial.minor ?? 0,
    patch: partial.patch ?? 0,
    prerelease: partial.prerelease,
  };
}

/** The exclusive upper bound implied by a partial version's precision. */
function precisionUpperBound(partial: PartialVersion): SemverParts | null {
  if (partial.minor === null) return { major: partial.major + 1, minor: 0, patch: 0, prerelease: null };
  if (partial.patch === null) {
    return { major: partial.major, minor: partial.minor + 1, patch: 0, prerelease: null };
  }
  return null;
}

/** `^`: compatible-with — the leftmost NON-ZERO component may not change. */
function caretUpperBound(partial: PartialVersion): SemverParts {
  if (partial.major !== 0) return { major: partial.major + 1, minor: 0, patch: 0, prerelease: null };
  const minor = partial.minor ?? 0;
  if (minor !== 0 || partial.minor === null) {
    return { major: 0, minor: minor + 1, patch: 0, prerelease: null };
  }
  if (partial.patch === null) return { major: 0, minor: 1, patch: 0, prerelease: null };
  return { major: 0, minor: 0, patch: partial.patch + 1, prerelease: null };
}

/** `~`: allow patch-level changes when a minor is named, minor-level otherwise. */
function tildeUpperBound(partial: PartialVersion): SemverParts {
  if (partial.minor === null) return { major: partial.major + 1, minor: 0, patch: 0, prerelease: null };
  return { major: partial.major, minor: partial.minor + 1, patch: 0, prerelease: null };
}

function satisfiesComparator(version: SemverParts, comparator: string): boolean | null {
  const trimmed = comparator.trim();
  if (trimmed === '*') return true;
  const match = /^([<>]=?|=|\^|~)?\s*(.+)$/.exec(trimmed);
  if (match === null) return null;
  const operator = match[1] ?? '=';
  const operandText = match[2] ?? '';
  if (operandText === '*') return true;
  const partial = parsePartialVersion(operandText);
  if (partial === null) return null;
  const bound = lowerBound(partial);

  switch (operator) {
    case '>':
      return compareSemver(version, bound) > 0;
    case '>=':
      return compareSemver(version, bound) >= 0;
    case '<':
      return compareSemver(version, bound) < 0;
    case '<=':
      return compareSemver(version, bound) <= 0;
    case '^': {
      const upper = caretUpperBound(partial);
      return compareSemver(version, bound) >= 0 && compareSemver(version, upper) < 0;
    }
    case '~': {
      const upper = tildeUpperBound(partial);
      return compareSemver(version, bound) >= 0 && compareSemver(version, upper) < 0;
    }
    default: {
      // Bare or `=`. A PARTIAL operand is a precision range (`1.2` is `1.2.x`),
      // which is npm's reading and the only one that makes `version = "1"`
      // mean anything useful in a declaration.
      const upper = precisionUpperBound(partial);
      if (upper === null) return compareSemver(version, bound) === 0;
      return compareSemver(version, bound) >= 0 && compareSemver(version, upper) < 0;
    }
  }
}

/**
 * Does `version` satisfy `range`? `null` means the range is not resolvable —
 * reported as `invalid-version-range` rather than guessed at.
 *
 * The grammar is `isSemverRange`'s: `||` separates alternatives, `,` and
 * whitespace separate the comparators an alternative ANDs together.
 */
export function satisfiesVersionRange(version: string, range: string): boolean | null {
  const parsed = parseSemverParts(version);
  if (parsed === null) return null;
  if (!isSemverRange(range)) return null;
  let anyAlternativeResolvable = false;
  for (const alternative of range.split('||')) {
    const comparators = alternative
      .split(',')
      .flatMap((chunk) => chunk.trim().split(/\s+/))
      .filter((comparator) => comparator.length > 0);
    if (comparators.length === 0) continue;
    let alternativeHolds = true;
    let alternativeResolvable = true;
    for (const comparator of comparators) {
      const result = satisfiesComparator(parsed, comparator);
      if (result === null) {
        alternativeResolvable = false;
        break;
      }
      if (!result) alternativeHolds = false;
    }
    if (!alternativeResolvable) continue;
    anyAlternativeResolvable = true;
    if (alternativeHolds) return true;
  }
  return anyAlternativeResolvable ? false : null;
}

// ── §2.4 rule 1's schema-file half (principle 13) ────────────────────────────
//
// Move 1a enforced the manifest-level half (a `verbs.human.args` entry whose
// `from` leaf names a reserved property) and said so in its own comment: a
// PURE parser cannot open the `input` schema. This is the other half. Neither
// is sufficient alone — a verb can keep its args clean and still declare
// `approved` in the schema both faces share.
//
// `RESERVED_AUTHORITY_PROPERTIES` is IMPORTED, never re-typed: two copies of an
// authority list is one copy that goes stale.

interface ReservedPropertyHit {
  readonly pointer: string;
  readonly property: string;
}

/**
 * Every `properties` key in the document, at any depth, that names a reserved
 * authority property. Walks the whole JSON value rather than only the root
 * schema: a nested object's `approved` is the same claim one level down, and
 * the manifest-level half already treats a dotted `from` path that way.
 */
function collectReservedAuthorityProperties(
  node: unknown,
  pointer: string,
  out: ReservedPropertyHit[],
): void {
  if (Array.isArray(node)) {
    node.forEach((element, index) => {
      collectReservedAuthorityProperties(element, `${pointer}/${index}`, out);
    });
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const table = node as Record<string, unknown>;
  const properties = table.properties;
  if (typeof properties === 'object' && properties !== null && !Array.isArray(properties)) {
    for (const key of Object.keys(properties)) {
      if (RESERVED_AUTHORITY_PROPERTIES.includes(key)) {
        out.push({ pointer: `${pointer}/properties/${escapeJsonPointerSegment(key)}`, property: key });
      }
    }
  }
  for (const [key, child] of Object.entries(table)) {
    collectReservedAuthorityProperties(child, `${pointer}/${escapeJsonPointerSegment(key)}`, out);
  }
}

function escapeJsonPointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

// ── the registry ─────────────────────────────────────────────────────────────

export class ExtensionRegistry {
  readonly #reader: RegistryFileReader;
  readonly #records: HeldRecord[] = [];

  constructor(options: ExtensionRegistryOptions = {}) {
    this.#reader = options.fileReader ?? createNodeFileReader();

    for (const entry of options.inBuild ?? []) {
      // Operator/build configuration errors are LOUD. The degrade posture of
      // §2.10 protects an operator from a broken EXTENSION; it is not a licence
      // to swallow a daemon build that named an extension incoherently.
      if (!isAbsolute(entry.root)) {
        throw new Error(
          `in-build extension "${entry.id}" declares a relative root ("${entry.root}"); an extension root must be absolute.`,
        );
      }
      this.#records.push({
        source: { kind: 'in-build' },
        root: entry.root,
        manifestText: entry.manifestText,
        enabled: entry.enabled ?? true,
        pinnedId: entry.id,
      });
    }

    for (const entry of options.localDirs ?? []) {
      if (!isAbsolute(entry.path)) {
        throw new Error(
          `local extension directory "${entry.path}" is not absolute; the installed set is named by absolute path.`,
        );
      }
      this.#records.push({
        source: { kind: 'local-dir', path: entry.path },
        root: entry.path,
        manifestText: null,
        enabled: entry.enabled ?? true,
        // Unknown until the manifest parses for the first time. Pinned then.
        pinnedId: null,
      });
    }
  }

  /**
   * The installed set, every manifest re-read and re-validated (§2.10).
   * A broken extension is PRESENT here with its problem named — S10-A4.
   */
  async list(): Promise<readonly ExtensionRecord[]> {
    const records: ExtensionRecord[] = [];
    for (const held of this.#records) {
      records.push(await this.#load(held));
    }
    return records;
  }

  /** One record by id, re-read like every other read path. `null` when nothing carries that id. */
  async get(id: string): Promise<ExtensionRecord | null> {
    for (const record of await this.list()) {
      if (record.id === id) return record;
    }
    return null;
  }

  /**
   * Flip an installed extension's `enabled` flag. IN MEMORY ONLY — there is no
   * persistence in v1 (D67: no install path, so nothing to persist about), and
   * the flag is what §2.10 says survives a re-parse. Returns false when no
   * record carries that id.
   */
  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    // The id must be resolved through a real read: a local dir's identity is
    // only known once its manifest has parsed at least once.
    await this.list();
    for (const held of this.#records) {
      if (held.pinnedId === id) {
        held.enabled = enabled;
        return true;
      }
    }
    return false;
  }

  /**
   * §2.8's second question: what does THIS project load? Reads
   * `<projectRoot>/.vimes/extensions.toml` and resolves each declared entry
   * against the installed set — with a full re-parse of every manifest, on
   * every call.
   *
   * ⚠ RESOLUTION IS NOT ACTIVATION. This returns a report and does nothing
   * else; no code loads, no capability is granted, no verb is registered.
   * Activation has no consumer in slice 10 (D72's hard line).
   */
  async resolveForProject(projectRoot: string): Promise<ProjectActivationReport> {
    const declarationPath = resolve(projectRoot, ...PROJECT_DECLARATION_SEGMENTS);
    const warnings: ManifestIssue[] = [];
    const empty = (present: boolean, apiVersion?: number): ProjectActivationReport => ({
      projectRoot,
      declarationPath,
      present,
      apiVersion,
      resolved: [],
      unresolved: [],
      reservedNodes: [],
      warnings,
    });

    let text: string | null;
    try {
      text = await this.#reader.readTextIfExists(declarationPath);
    } catch (error) {
      warnings.push({
        code: 'project-declaration-unreadable',
        path: declarationPath,
        message: `the project declaration could not be read: ${describeError(error)}. The project activates nothing.`,
      });
      return empty(false);
    }
    // §2.8: a project that declares nothing loads nothing. Not an error — most
    // projects never grow a `.vimes/` directory.
    if (text === null) return empty(false);

    let document: unknown;
    try {
      document = parseToml(text);
    } catch (error) {
      const where = error instanceof TomlError ? ` at line ${error.line}, column ${error.column}` : '';
      warnings.push({
        code: 'project-declaration-invalid-toml',
        path: declarationPath,
        message: `the project declaration is not valid TOML${where}: ${describeError(error)}. The project activates nothing — a broken declaration must not take the project's engine surfaces down.`,
      });
      return empty(true);
    }
    if (!isTable(document)) {
      warnings.push({
        code: 'project-declaration-invalid-toml',
        path: declarationPath,
        message: 'the project declaration must be a TOML table. The project activates nothing.',
      });
      return empty(true);
    }

    let apiVersion: number | undefined;
    const rawApiVersion = document.api_version;
    if (typeof rawApiVersion === 'number' && Number.isInteger(rawApiVersion)) {
      apiVersion = rawApiVersion;
      if (rawApiVersion > API_VERSION) {
        // Same posture as the manifest's too-new refusal (§2.3), one file over:
        // acting on half a vocabulary we do not understand is worse than
        // activating nothing and saying why.
        warnings.push({
          code: 'project-declaration-api-version-too-new',
          path: 'api_version',
          message: `this declaration is written for api_version ${rawApiVersion}; this vimes understands up to ${API_VERSION}. Upgrade vimes. The project activates nothing.`,
        });
        return empty(true, apiVersion);
      }
    } else if (rawApiVersion !== undefined) {
      warnings.push({
        code: 'project-declaration-api-version-invalid',
        path: 'api_version',
        message: '`api_version` must be an integer; it is ignored.',
      });
    }

    for (const key of Object.keys(document)) {
      if (key !== 'api_version' && key !== 'extension' && key !== 'node') {
        warnings.push({
          code: 'unknown-field',
          path: key,
          message: `\`${key}\` is not part of the project declaration's vocabulary; it is ignored.`,
        });
      }
    }

    const installed = await this.list();
    const resolved: ResolvedExtension[] = [];
    const unresolved: UnresolvedExtension[] = [];

    const rawExtensions = document.extension;
    if (rawExtensions !== undefined && !Array.isArray(rawExtensions)) {
      warnings.push({
        code: 'project-declaration-field-type',
        path: 'extension',
        message: '`[[extension]]` must be an array of tables; it is ignored.',
      });
    } else if (Array.isArray(rawExtensions)) {
      rawExtensions.forEach((element, index) => {
        const path = `extension[${index}]`;
        if (!isTable(element)) {
          warnings.push({
            code: 'project-declaration-field-type',
            path,
            message: 'every `[[extension]]` entry must be a table; it is ignored.',
          });
          return;
        }
        const id = typeof element.id === 'string' ? element.id.trim() : '';
        if (id.length === 0) {
          warnings.push({
            code: 'project-declaration-field-missing',
            path: `${path}.id`,
            message: 'an `[[extension]]` entry needs a non-empty string `id`; it is ignored.',
          });
          return;
        }
        let range: string | undefined;
        if (typeof element.version === 'string' && element.version.trim().length > 0) {
          range = element.version.trim();
        } else if (element.version !== undefined) {
          warnings.push({
            code: 'project-declaration-field-type',
            path: `${path}.version`,
            message: '`version` must be a non-empty semver RANGE string; the entry is treated as unpinned.',
          });
        }
        const declaredEnabled = typeof element.enabled === 'boolean' ? element.enabled : true;
        const config = isTable(element.config) ? element.config : undefined;

        const record = installed.find((candidate) => candidate.id === id);
        if (record === undefined) {
          unresolved.push({
            id,
            range,
            reason: 'unknown-extension',
            message: `no installed extension carries the id "${id}".`,
          });
          return;
        }
        if (record.manifest === null || record.errors.length > 0) {
          unresolved.push({
            id,
            range,
            reason: 'extension-not-loadable',
            installedVersion: record.manifest?.version,
            message: `"${id}" is installed but its manifest did not load cleanly (${record.errors.length} error(s)); a range cannot be resolved against it.`,
          });
          return;
        }
        const installedVersion = record.manifest.version;
        if (range !== undefined) {
          const satisfied = satisfiesVersionRange(installedVersion, range);
          if (satisfied === null) {
            unresolved.push({
              id,
              range,
              reason: 'invalid-version-range',
              installedVersion,
              message: `"${range}" is not a semver range this engine can resolve against the installed version ${installedVersion}.`,
            });
            return;
          }
          if (!satisfied) {
            unresolved.push({
              id,
              range,
              reason: 'version-mismatch',
              installedVersion,
              message: `the project declares "${id}" ${range}; the installed version is ${installedVersion}.`,
            });
            return;
          }
        }
        resolved.push({
          id,
          range,
          version: installedVersion,
          source: record.source,
          declaredEnabled,
          registryEnabled: record.enabled,
          config,
        });
      });
    }

    const reservedNodes: ReservedNodeDeclaration[] = [];
    const rawNodes = document.node;
    if (rawNodes !== undefined && !Array.isArray(rawNodes)) {
      warnings.push({
        code: 'project-declaration-field-type',
        path: 'node',
        message: '`[[node]]` must be an array of tables; it is ignored.',
      });
    } else if (Array.isArray(rawNodes)) {
      // §2.8: RESERVED. Accepted so the shape exists and a forward-looking
      // declaration is not rejected; acted on by nothing, and deliberately not
      // validated beyond its two field types — validating a shape nobody has
      // designed would pin it by accident.
      for (const element of rawNodes) {
        if (!isTable(element)) continue;
        const id = typeof element.id === 'string' ? element.id : null;
        const extensions = Array.isArray(element.extensions)
          ? element.extensions.filter((value): value is string => typeof value === 'string')
          : [];
        reservedNodes.push({ id, extensions, reserved: true });
      }
    }

    return {
      projectRoot,
      declarationPath,
      present: true,
      apiVersion,
      resolved,
      unresolved,
      reservedNodes,
      warnings,
    };
  }

  // ── one record, re-read and re-validated ───────────────────────────────────

  async #load(held: HeldRecord): Promise<ExtensionRecord> {
    const errors: ManifestIssue[] = [];
    const warnings: ManifestIssue[] = [];

    const manifestPath =
      held.source.kind === 'local-dir' ? resolve(held.root, MANIFEST_FILENAME) : '(in-build)';

    let text: string | null = held.manifestText;
    if (held.source.kind === 'local-dir') {
      try {
        text = await this.#reader.readTextIfExists(manifestPath);
      } catch (error) {
        errors.push({
          code: 'manifest-unreadable',
          path: manifestPath,
          message: `the manifest could not be read: ${describeError(error)}.`,
        });
        return this.#record(held, null, errors, warnings);
      }
      if (text === null) {
        errors.push({
          code: 'manifest-missing',
          path: manifestPath,
          message: `no \`${MANIFEST_FILENAME}\` in "${held.root}" — an operator-named extension directory must contain one.`,
        });
        return this.#record(held, null, errors, warnings);
      }
    }
    if (text === null) {
      // Unreachable for a well-formed construction (in-build entries always
      // carry text); stated rather than assumed.
      errors.push({
        code: 'manifest-missing',
        path: manifestPath,
        message: 'this in-build extension carries no manifest text.',
      });
      return this.#record(held, null, errors, warnings);
    }

    const result = parseExtensionManifest(text);
    warnings.push(...result.warnings);
    if (!result.ok) {
      errors.push(...result.errors);
      return this.#record(held, null, errors, warnings);
    }

    const manifest = result.manifest;
    if (held.pinnedId !== null && manifest.id !== held.pinnedId) {
      errors.push({
        code: 'extension-id-drift',
        path: 'id',
        message: `this extension is registered as "${held.pinnedId}" but its manifest now declares "${manifest.id}". Identity may not drift under re-parse (§2.10): the enabled flag an operator set and the range a project declared both name the registered id, and silently following the new one would move them onto something nobody named.`,
      });
    } else if (held.pinnedId === null) {
      held.pinnedId = manifest.id;
    }

    await this.#checkVerbInputSchemas(held, manifest, errors, warnings);
    return this.#record(held, manifest, errors, warnings);
  }

  /**
   * §2.4 rule 1's schema-file half. The registry CAN read files, so it
   * completes the rule the pure parser could only name.
   *
   * Scope is `[[verbs]].input` deliberately: #13 is about the payload a
   * proposal arrives with, and a verb's `input` is that payload's schema. A
   * workflow's `record` schema describes stored instance state, not a
   * proposal, and is left alone until something argues otherwise.
   */
  async #checkVerbInputSchemas(
    held: HeldRecord,
    manifest: ParsedManifest,
    errors: ManifestIssue[],
    warnings: ManifestIssue[],
  ): Promise<void> {
    for (const [index, verb] of manifest.verbs.entries()) {
      const path = `verbs[${index}].input`;
      const schemaPath = resolve(held.root, verb.input);
      // The parser could not check this either: `input` is EXTENSION-RELATIVE,
      // and a path that climbs out of the extension root is not. The registry
      // is the first code that can tell, so it is the code that refuses —
      // before the read, not after.
      if (!isWithinRoot(held.root, schemaPath)) {
        errors.push({
          code: 'verb-input-schema-outside-root',
          path,
          message: `"${verb.input}" resolves outside the extension root ("${held.root}"). A verb's \`input\` schema is extension-relative; a path that escapes the root is not.`,
        });
        continue;
      }

      let schemaText: string | null;
      try {
        schemaText = await this.#reader.readTextIfExists(schemaPath);
      } catch (error) {
        warnings.push({
          code: 'verb-input-schema-unreadable',
          path,
          message: `the \`input\` schema for verb "${verb.id}" could not be read: ${describeError(error)}. The verb is listed; its authority-property rule could not be checked.`,
        });
        continue;
      }
      if (schemaText === null) {
        warnings.push({
          code: 'verb-input-schema-missing',
          path,
          message: `the \`input\` schema for verb "${verb.id}" is missing at "${schemaPath}". The verb is listed; its authority-property rule could not be checked.`,
        });
        continue;
      }

      let schema: unknown;
      try {
        schema = JSON.parse(schemaText);
      } catch (error) {
        warnings.push({
          code: 'verb-input-schema-not-json',
          path,
          message: `the \`input\` schema for verb "${verb.id}" is not valid JSON: ${describeError(error)}. The verb is listed; its authority-property rule could not be checked.`,
        });
        continue;
      }

      const hits: ReservedPropertyHit[] = [];
      collectReservedAuthorityProperties(schema, '', hits);
      for (const hit of hits) {
        errors.push({
          code: 'reserved-authority-property-in-schema',
          path: `${path}#${hit.pointer}`,
          message: `verb "${verb.id}"'s \`input\` schema declares "${hit.property}", a RESERVED AUTHORITY PROPERTY (${RESERVED_AUTHORITY_PROPERTIES.join(', ')}). Authority is never carried in a payload (extension-model §2.4 rule 1, principle 13): the engine stamps the proposer from the channel the invocation arrived on. A schema that accepts "${hit.property}" is asking the caller to declare its own authority.`,
        });
      }
    }
  }

  #record(
    held: HeldRecord,
    manifest: ParsedManifest | null,
    errors: readonly ManifestIssue[],
    warnings: readonly ManifestIssue[],
  ): ExtensionRecord {
    return {
      id: held.pinnedId,
      source: held.source,
      enabled: held.enabled,
      manifest,
      errors,
      warnings,
      runnable: held.enabled && manifest !== null && errors.length === 0,
    };
  }
}

// ── small shared helpers ─────────────────────────────────────────────────────

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  if (relativePath.length === 0) return false;
  if (isAbsolute(relativePath)) return false;
  return relativePath !== '..' && !relativePath.startsWith(`..${sep}`);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
