import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ExtensionRegistry,
  MANIFEST_FILENAME,
  satisfiesVersionRange,
  type RegistryFileReader,
} from './extensionRegistry.js';

// ─── S10·Move-1b — the extension registry (S10-A3/A4/A5, registry half) ──────
//
// ⚠ **EVERY FILE THIS SUITE TOUCHES LIVES IN A FRESH `mkdtemp` DIRECTORY**, and
// every one of them is removed in `afterEach`. The one exception is READ-ONLY:
// two cases point the registry at the repo's own `fixtures/extensions/
// vimes-tasks` to prove the real Move 1a manifest and its real schema stubs
// load through the real filesystem adapter. Nothing here writes inside the
// checkout.
//
// The property under test that everything else hangs off is §2.10's: **every
// read path re-reads.** So the freshness cases do not assert on a returned
// shape and stop — they EDIT THE FILE BETWEEN CALLS and assert the second call
// saw the edit. A cache that never invalidated would pass a single-call
// assertion perfectly.
//
// The second property is S10-A4's degrade posture: a broken extension is
// LISTED WITH ITS PROBLEM NAMED. Every degrade case below therefore asserts
// three things — that the call did not throw, that the entry is PRESENT, and
// that `runnable` is false. Any one of those alone is satisfiable by a wrong
// implementation (a throw-swallower, a silent dropper, an optimist).

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const VIMES_TASKS_FIXTURE = join(REPO_ROOT, 'fixtures', 'extensions', 'vimes-tasks');

// A minimal manifest that parses clean. Small on purpose: the vimes-tasks
// fixture is the realism case, and a 200-line manifest in every unit test would
// make a schema-file assertion read like a manifest assertion.
function manifestText(
  options: { id?: string; version?: string; input?: string; name?: string } = {},
): string {
  const id = options.id ?? 'demo-ext';
  const version = options.version ?? '1.0.0';
  const input = options.input ?? 'schemas/do-thing.json';
  const name = options.name ?? 'Demo';
  return [
    `id          = "${id}"`,
    `name        = "${name}"`,
    `version     = "${version}"`,
    'api_version = 1',
    'capabilities = ["verbs.register"]',
    '',
    '[runtime]',
    'kind = "in-process"',
    '',
    '[[verbs]]',
    'id     = "do_thing"',
    'title  = "Do thing"',
    'target = "task"',
    `input  = "${input}"`,
    'agent  = { server = "vimes_board", tool = "do_thing" }',
    '',
  ].join('\n');
}

const CLEAN_SCHEMA = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: { note: { type: 'string' } },
});

const tempRoots: string[] = [];

async function makeTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'vimes-ext-registry-'));
  tempRoots.push(path);
  return path;
}

/** A valid extension directory: manifest + the one schema file its verb names. */
async function makeExtensionDir(
  options: {
    id?: string;
    version?: string;
    input?: string;
    manifest?: string;
    schema?: string | null;
    schemaAt?: string;
  } = {},
): Promise<string> {
  const dir = await makeTempDir();
  const text = options.manifest ?? manifestText(options);
  await writeFile(join(dir, MANIFEST_FILENAME), text, 'utf8');
  if (options.schema !== null) {
    const relativeSchemaPath = options.schemaAt ?? options.input ?? 'schemas/do-thing.json';
    const schemaPath = join(dir, relativeSchemaPath);
    await mkdir(join(schemaPath, '..'), { recursive: true });
    await writeFile(schemaPath, options.schema ?? CLEAN_SCHEMA, 'utf8');
  }
  return dir;
}

async function writeProjectDeclaration(projectRoot: string, text: string): Promise<void> {
  await mkdir(join(projectRoot, '.vimes'), { recursive: true });
  await writeFile(join(projectRoot, '.vimes', 'extensions.toml'), text, 'utf8');
}

afterEach(async () => {
  // CLAUDE.md's global rule, and a real hazard here: a leaked mkdtemp directory
  // would make a LATER run of the freshness cases read a stale manifest.
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path !== undefined) await rm(path, { recursive: true, force: true });
  }
});

describe('ExtensionRegistry — the installed set', () => {
  it('lists an operator-named local directory with its parsed manifest and provenance', async () => {
    const dir = await makeExtensionDir({ id: 'demo-ext', version: '1.2.3' });
    const registry = new ExtensionRegistry({ localDirs: [{ path: dir }] });

    const records = await registry.list();

    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record?.id).toBe('demo-ext');
    expect(record?.source).toEqual({ kind: 'local-dir', path: dir });
    expect(record?.enabled).toBe(true);
    expect(record?.manifest?.version).toBe('1.2.3');
    expect(record?.errors).toEqual([]);
    expect(record?.runnable).toBe(true);
  });

  it('lists an in-build entry through the SAME code path, from injected manifest text', async () => {
    const dir = await makeExtensionDir({ id: 'tier-one' });
    const registry = new ExtensionRegistry({
      inBuild: [{ id: 'tier-one', manifestText: manifestText({ id: 'tier-one' }), root: dir }],
    });

    const records = await registry.list();

    expect(records[0]?.source).toEqual({ kind: 'in-build' });
    expect(records[0]?.id).toBe('tier-one');
    expect(records[0]?.runnable).toBe(true);
    // The schema-file rule applies to Tier 1 too — it read the real file.
    expect(records[0]?.warnings.map((warning) => warning.code)).not.toContain(
      'verb-input-schema-missing',
    );
  });

  it('loads the real vimes-tasks fixture — manifest and schema stubs, off the real disk', async () => {
    const registry = new ExtensionRegistry({ localDirs: [{ path: VIMES_TASKS_FIXTURE }] });

    const record = await registry.get('vimes-tasks');

    expect(record).not.toBeNull();
    expect(record?.errors).toEqual([]);
    expect(record?.manifest?.version).toBe('1.0.0');
    expect(record?.manifest?.verbs).toHaveLength(7);
    expect(record?.runnable).toBe(true);
    // The stubs are all present, so nothing degraded on a missing schema file.
    expect(record?.warnings.map((warning) => warning.code)).not.toContain(
      'verb-input-schema-missing',
    );
  });

  it('`get` returns null for an id nothing carries', async () => {
    const dir = await makeExtensionDir();
    const registry = new ExtensionRegistry({ localDirs: [{ path: dir }] });

    expect(await registry.get('not-installed')).toBeNull();
  });

  it('refuses a relative local directory and a relative in-build root at construction', () => {
    // Operator/build configuration errors are LOUD — the degrade posture
    // protects an operator from a broken EXTENSION, not from a broken registry.
    expect(() => new ExtensionRegistry({ localDirs: [{ path: 'relative/dir' }] })).toThrow(
      /not absolute/,
    );
    expect(
      () =>
        new ExtensionRegistry({
          inBuild: [{ id: 'x', manifestText: manifestText(), root: 'relative/dir' }],
        }),
    ).toThrow(/absolute/);
  });

  it('takes an injected file reader and touches no disk at all', async () => {
    const reads: string[] = [];
    const reader: RegistryFileReader = {
      async readTextIfExists(path: string): Promise<string | null> {
        reads.push(path);
        if (path.endsWith(MANIFEST_FILENAME)) return manifestText({ id: 'injected' });
        if (path.endsWith('do-thing.json')) return CLEAN_SCHEMA;
        return null;
      },
    };
    const registry = new ExtensionRegistry({
      localDirs: [{ path: '/nowhere/injected' }],
      fileReader: reader,
    });

    const records = await registry.list();

    expect(records[0]?.id).toBe('injected');
    expect(records[0]?.runnable).toBe(true);
    expect(reads).toEqual([
      join('/nowhere/injected', MANIFEST_FILENAME),
      join('/nowhere/injected', 'schemas', 'do-thing.json'),
    ]);
  });
});

describe('ExtensionRegistry — re-parse on use (§2.10)', () => {
  it('`list` re-reads the manifest from disk on every call', async () => {
    const dir = await makeExtensionDir({ id: 'demo-ext', version: '1.0.0' });
    const registry = new ExtensionRegistry({ localDirs: [{ path: dir }] });

    const before = await registry.list();
    expect(before[0]?.manifest?.version).toBe('1.0.0');

    await writeFile(
      join(dir, MANIFEST_FILENAME),
      manifestText({ id: 'demo-ext', version: '2.5.0', name: 'Renamed' }),
      'utf8',
    );

    const after = await registry.list();
    expect(after[0]?.manifest?.version).toBe('2.5.0');
    expect(after[0]?.manifest?.name).toBe('Renamed');
  });

  it('`get` re-reads too — and sees a manifest that BREAKS between calls', async () => {
    const dir = await makeExtensionDir({ id: 'demo-ext' });
    const registry = new ExtensionRegistry({ localDirs: [{ path: dir }] });

    expect((await registry.get('demo-ext'))?.runnable).toBe(true);

    await writeFile(join(dir, MANIFEST_FILENAME), 'id = "demo-ext"\nthis is not toml', 'utf8');

    const after = await registry.get('demo-ext');
    // Still LISTED under its pinned id, now with its problem named.
    expect(after).not.toBeNull();
    expect(after?.runnable).toBe(false);
    expect(after?.errors.map((error) => error.code)).toContain('toml-parse-error');
  });

  it('preserves `enabled` and source across a re-parse, and nothing else', async () => {
    const dir = await makeExtensionDir({ id: 'demo-ext', version: '1.0.0' });
    const registry = new ExtensionRegistry({ localDirs: [{ path: dir, enabled: false }] });

    const before = await registry.list();
    expect(before[0]?.enabled).toBe(false);
    // Disabled is not runnable, however clean the manifest is.
    expect(before[0]?.errors).toEqual([]);
    expect(before[0]?.runnable).toBe(false);

    expect(await registry.setEnabled('demo-ext', true)).toBe(true);
    await writeFile(
      join(dir, MANIFEST_FILENAME),
      manifestText({ id: 'demo-ext', version: '3.0.0' }),
      'utf8',
    );

    const after = await registry.list();
    expect(after[0]?.enabled).toBe(true);
    expect(after[0]?.manifest?.version).toBe('3.0.0');
    expect(after[0]?.runnable).toBe(true);
    expect(await registry.setEnabled('nobody', true)).toBe(false);
  });
});

describe('ExtensionRegistry — listed-with-warning degrades (S10-A4)', () => {
  it('a broken-TOML directory is listed, never thrown and never absent', async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, MANIFEST_FILENAME), 'id = "broken\nnot toml at all', 'utf8');
    const registry = new ExtensionRegistry({ localDirs: [{ path: dir }] });

    const records = await registry.list();

    expect(records).toHaveLength(1);
    // Never parsed, so it has no identity to be listed UNDER — but it is listed.
    expect(records[0]?.id).toBeNull();
    expect(records[0]?.source).toEqual({ kind: 'local-dir', path: dir });
    expect(records[0]?.manifest).toBeNull();
    expect(records[0]?.errors.map((error) => error.code)).toContain('toml-parse-error');
    expect(records[0]?.runnable).toBe(false);
  });

  it('a directory with no vimes-extension.toml is listed with `manifest-missing`', async () => {
    const dir = await makeTempDir();
    const registry = new ExtensionRegistry({ localDirs: [{ path: dir }] });

    const records = await registry.list();

    expect(records[0]?.errors.map((error) => error.code)).toEqual(['manifest-missing']);
    expect(records[0]?.runnable).toBe(false);
  });

  it('a reader that FAILS (not "absent") is listed with `manifest-unreadable`', async () => {
    const reader: RegistryFileReader = {
      async readTextIfExists(): Promise<string | null> {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      },
    };
    const registry = new ExtensionRegistry({
      localDirs: [{ path: '/nowhere/locked' }],
      fileReader: reader,
    });

    const records = await registry.list();

    expect(records[0]?.errors[0]?.code).toBe('manifest-unreadable');
    expect(records[0]?.errors[0]?.message).toContain('permission denied');
    expect(records[0]?.runnable).toBe(false);
  });

  it('a manifest that fails validation is listed with the parser’s structured errors', async () => {
    const dir = await makeExtensionDir({
      manifest: manifestText({ version: 'not-semver' }),
    });
    const registry = new ExtensionRegistry({ localDirs: [{ path: dir }] });

    const records = await registry.list();

    expect(records[0]?.errors.map((error) => error.code)).toContain('version-not-semver');
    expect(records[0]?.runnable).toBe(false);
  });

  it('carries the parser’s WARNINGS through without costing runnability', async () => {
    const dir = await makeExtensionDir({
      manifest: `${manifestText()}\n[[events]]\non = "no_such_event"\ndeliver = "worker"\n`,
    });
    const registry = new ExtensionRegistry({ localDirs: [{ path: dir }] });

    const records = await registry.list();

    expect(records[0]?.warnings.map((warning) => warning.code)).toContain('unknown-event-kind');
    expect(records[0]?.errors).toEqual([]);
    expect(records[0]?.runnable).toBe(true);
  });

  it('an id that DRIFTS under re-parse is an error, and the pinned id does not move', async () => {
    const dir = await makeExtensionDir({ id: 'demo-ext' });
    const registry = new ExtensionRegistry({ localDirs: [{ path: dir }] });

    expect((await registry.list())[0]?.id).toBe('demo-ext');

    await writeFile(join(dir, MANIFEST_FILENAME), manifestText({ id: 'someone-else' }), 'utf8');

    const after = await registry.list();
    expect(after[0]?.id).toBe('demo-ext');
    expect(after[0]?.errors.map((error) => error.code)).toContain('extension-id-drift');
    expect(after[0]?.errors[0]?.message).toContain('someone-else');
    expect(after[0]?.runnable).toBe(false);
    // And the drifted name is not reachable under its new id either.
    expect(await registry.get('someone-else')).toBeNull();
  });

  it('an in-build entry whose manifest disagrees with its registered id drifts identically', async () => {
    const dir = await makeExtensionDir({ id: 'tier-one' });
    const registry = new ExtensionRegistry({
      inBuild: [{ id: 'tier-one', manifestText: manifestText({ id: 'mislabelled' }), root: dir }],
    });

    const records = await registry.list();

    expect(records[0]?.id).toBe('tier-one');
    expect(records[0]?.errors.map((error) => error.code)).toContain('extension-id-drift');
    expect(records[0]?.runnable).toBe(false);
  });
});

describe('ExtensionRegistry — #13, the schema-file half of §2.4 rule 1', () => {
  it('REFUSES a verb whose input schema declares a reserved authority property', async () => {
    const dir = await makeExtensionDir({
      schema: JSON.stringify({
        type: 'object',
        properties: { note: { type: 'string' }, approved: { type: 'boolean' } },
      }),
    });
    const registry = new ExtensionRegistry({ localDirs: [{ path: dir }] });

    const records = await registry.list();

    const refusal = records[0]?.errors.find(
      (error) => error.code === 'reserved-authority-property-in-schema',
    );
    expect(refusal).toBeDefined();
    expect(refusal?.path).toBe('verbs[0].input#/properties/approved');
    expect(records[0]?.runnable).toBe(false);
    // The manifest itself is fine — this refusal exists only because the
    // registry can open a file the pure parser cannot.
    expect(records[0]?.manifest?.id).toBe('demo-ext');
  });

  it('finds a reserved property NESTED inside the schema, not only at the root', async () => {
    const dir = await makeExtensionDir({
      schema: JSON.stringify({
        type: 'object',
        properties: {
          decision: { type: 'object', properties: { proposed_by: { type: 'string' } } },
        },
      }),
    });
    const registry = new ExtensionRegistry({ localDirs: [{ path: dir }] });

    const records = await registry.list();

    const refusal = records[0]?.errors.find(
      (error) => error.code === 'reserved-authority-property-in-schema',
    );
    expect(refusal?.path).toBe('verbs[0].input#/properties/decision/properties/proposed_by');
    expect(records[0]?.runnable).toBe(false);
  });

  it('accepts every reserved name only as a refusal — all four are enforced', async () => {
    for (const property of ['proposed_by', 'approved', 'authority', 'actor']) {
      const dir = await makeExtensionDir({
        schema: JSON.stringify({ type: 'object', properties: { [property]: { type: 'string' } } }),
      });
      const registry = new ExtensionRegistry({ localDirs: [{ path: dir }] });
      const records = await registry.list();
      expect(
        records[0]?.errors.map((error) => error.code),
        `"${property}" must be refused`,
      ).toContain('reserved-authority-property-in-schema');
    }
  });

  it('a MISSING schema file warns on that verb and leaves the extension runnable', async () => {
    const dir = await makeExtensionDir({ schema: null });
    const registry = new ExtensionRegistry({ localDirs: [{ path: dir }] });

    const records = await registry.list();

    expect(records[0]?.warnings.map((warning) => warning.code)).toContain(
      'verb-input-schema-missing',
    );
    expect(records[0]?.errors).toEqual([]);
    expect(records[0]?.runnable).toBe(true);
  });

  it('an UNPARSEABLE schema file warns on that verb and leaves the extension runnable', async () => {
    const dir = await makeExtensionDir({ schema: '{ this is not json' });
    const registry = new ExtensionRegistry({ localDirs: [{ path: dir }] });

    const records = await registry.list();

    expect(records[0]?.warnings.map((warning) => warning.code)).toContain(
      'verb-input-schema-not-json',
    );
    expect(records[0]?.runnable).toBe(true);
  });

  it('refuses an `input` path that climbs out of the extension root, WITHOUT reading it', async () => {
    const reads: string[] = [];
    const reader: RegistryFileReader = {
      async readTextIfExists(path: string): Promise<string | null> {
        reads.push(path);
        if (path.endsWith(MANIFEST_FILENAME)) {
          return manifestText({ input: '../../etc/passwd' });
        }
        return null;
      },
    };
    const registry = new ExtensionRegistry({
      localDirs: [{ path: '/nowhere/escaper' }],
      fileReader: reader,
    });

    const records = await registry.list();

    expect(records[0]?.errors.map((error) => error.code)).toContain(
      'verb-input-schema-outside-root',
    );
    expect(records[0]?.runnable).toBe(false);
    // The refusal happens BEFORE the read, so the escaping path was never opened.
    expect(reads).toEqual([join('/nowhere/escaper', MANIFEST_FILENAME)]);
  });
});

describe('ExtensionRegistry — resolveForProject (§2.8)', () => {
  it('resolves a declared extension against the installed version', async () => {
    const dir = await makeExtensionDir({ id: 'demo-ext', version: '1.4.2' });
    const projectRoot = await makeTempDir();
    await writeProjectDeclaration(
      projectRoot,
      [
        'api_version = 1',
        '',
        '[[extension]]',
        'id      = "demo-ext"',
        'version = ">=1.2, <2"',
        'enabled = true',
        '',
        '[extension.config]',
        'inbox = "backlog"',
      ].join('\n'),
    );
    const registry = new ExtensionRegistry({ localDirs: [{ path: dir }] });

    const report = await registry.resolveForProject(projectRoot);

    expect(report.present).toBe(true);
    expect(report.apiVersion).toBe(1);
    expect(report.unresolved).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.resolved).toHaveLength(1);
    expect(report.resolved[0]?.id).toBe('demo-ext');
    expect(report.resolved[0]?.version).toBe('1.4.2');
    expect(report.resolved[0]?.range).toBe('>=1.2, <2');
    expect(report.resolved[0]?.source).toEqual({ kind: 'local-dir', path: dir });
    expect(report.resolved[0]?.declaredEnabled).toBe(true);
    expect(report.resolved[0]?.registryEnabled).toBe(true);
    // RESERVED and OPAQUE: carried through, never interpreted.
    expect(report.resolved[0]?.config).toEqual({ inbox: 'backlog' });
  });

  it('a MISSING declaration is an empty activation, not an error', async () => {
    const dir = await makeExtensionDir();
    const projectRoot = await makeTempDir();
    const registry = new ExtensionRegistry({ localDirs: [{ path: dir }] });

    const report = await registry.resolveForProject(projectRoot);

    expect(report.present).toBe(false);
    expect(report.resolved).toEqual([]);
    expect(report.unresolved).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.declarationPath).toBe(join(projectRoot, '.vimes', 'extensions.toml'));
  });

  it('a MALFORMED declaration warns and activates nothing — it never throws', async () => {
    const dir = await makeExtensionDir({ id: 'demo-ext' });
    const projectRoot = await makeTempDir();
    await writeProjectDeclaration(projectRoot, '[[extension\nid = "demo-ext"');
    const registry = new ExtensionRegistry({ localDirs: [{ path: dir }] });

    const report = await registry.resolveForProject(projectRoot);

    expect(report.present).toBe(true);
    expect(report.resolved).toEqual([]);
    expect(report.warnings.map((warning) => warning.code)).toEqual([
      'project-declaration-invalid-toml',
    ]);
  });

  it('a range that does not match names the INSTALLED version in the reason', async () => {
    const dir = await makeExtensionDir({ id: 'demo-ext', version: '0.9.0' });
    const projectRoot = await makeTempDir();
    await writeProjectDeclaration(
      projectRoot,
      'api_version = 1\n\n[[extension]]\nid = "demo-ext"\nversion = ">=1.2, <2"\n',
    );
    const registry = new ExtensionRegistry({ localDirs: [{ path: dir }] });

    const report = await registry.resolveForProject(projectRoot);

    expect(report.resolved).toEqual([]);
    expect(report.unresolved).toHaveLength(1);
    expect(report.unresolved[0]?.reason).toBe('version-mismatch');
    expect(report.unresolved[0]?.installedVersion).toBe('0.9.0');
    expect(report.unresolved[0]?.message).toContain('0.9.0');
  });

  it('an unknown id is unresolved with a reason, not silently dropped', async () => {
    const projectRoot = await makeTempDir();
    await writeProjectDeclaration(
      projectRoot,
      'api_version = 1\n\n[[extension]]\nid = "never-installed"\n',
    );
    const registry = new ExtensionRegistry({});

    const report = await registry.resolveForProject(projectRoot);

    expect(report.unresolved[0]?.reason).toBe('unknown-extension');
    expect(report.unresolved[0]?.id).toBe('never-installed');
  });

  it('an installed-but-broken extension is unresolved as `extension-not-loadable`', async () => {
    const dir = await makeExtensionDir({ id: 'demo-ext' });
    await writeFile(join(dir, MANIFEST_FILENAME), 'not [ toml', 'utf8');
    const projectRoot = await makeTempDir();
    await writeProjectDeclaration(projectRoot, '[[extension]]\nid = "demo-ext"\n');
    // The registry must know the id before the manifest breaks, exactly as a
    // running daemon would: list once (pinning it), then resolve.
    const registry = new ExtensionRegistry({
      inBuild: [{ id: 'demo-ext', manifestText: 'not [ toml', root: dir }],
    });

    const report = await registry.resolveForProject(projectRoot);

    expect(report.unresolved[0]?.reason).toBe('extension-not-loadable');
  });

  it('an unresolvable range is `invalid-version-range`, not a false mismatch', async () => {
    const dir = await makeExtensionDir({ id: 'demo-ext', version: '1.0.0' });
    const projectRoot = await makeTempDir();
    await writeProjectDeclaration(
      projectRoot,
      '[[extension]]\nid = "demo-ext"\nversion = "sometime after tuesday"\n',
    );
    const registry = new ExtensionRegistry({ localDirs: [{ path: dir }] });

    const report = await registry.resolveForProject(projectRoot);

    expect(report.unresolved[0]?.reason).toBe('invalid-version-range');
  });

  it('surfaces reserved [[node]] blocks as reserved, and acts on nothing', async () => {
    const dir = await makeExtensionDir({ id: 'demo-ext' });
    const projectRoot = await makeTempDir();
    await writeProjectDeclaration(
      projectRoot,
      [
        'api_version = 1',
        '',
        '[[extension]]',
        'id = "demo-ext"',
        '',
        '[[node]]',
        'id         = "some-node"',
        'extensions = ["demo-ext"]',
      ].join('\n'),
    );
    const registry = new ExtensionRegistry({ localDirs: [{ path: dir }] });

    const report = await registry.resolveForProject(projectRoot);

    expect(report.reservedNodes).toEqual([
      { id: 'some-node', extensions: ['demo-ext'], reserved: true },
    ]);
    // Reserved means reserved: the block changes no resolution.
    expect(report.resolved).toHaveLength(1);
    expect(report.warnings).toEqual([]);
  });

  it('carries a declaration-level `enabled = false` WITHOUT activating or hiding it', async () => {
    const dir = await makeExtensionDir({ id: 'demo-ext' });
    const projectRoot = await makeTempDir();
    await writeProjectDeclaration(
      projectRoot,
      '[[extension]]\nid = "demo-ext"\nenabled = false\n',
    );
    const registry = new ExtensionRegistry({ localDirs: [{ path: dir, enabled: false }] });

    const report = await registry.resolveForProject(projectRoot);

    expect(report.resolved[0]?.declaredEnabled).toBe(false);
    expect(report.resolved[0]?.registryEnabled).toBe(false);
  });

  it('refuses a declaration written for a newer vocabulary and activates nothing', async () => {
    const dir = await makeExtensionDir({ id: 'demo-ext' });
    const projectRoot = await makeTempDir();
    await writeProjectDeclaration(
      projectRoot,
      'api_version = 99\n\n[[extension]]\nid = "demo-ext"\n',
    );
    const registry = new ExtensionRegistry({ localDirs: [{ path: dir }] });

    const report = await registry.resolveForProject(projectRoot);

    expect(report.warnings[0]?.code).toBe('project-declaration-api-version-too-new');
    expect(report.resolved).toEqual([]);
  });

  it('warns on a declaration key the vocabulary does not know, and keeps going', async () => {
    const dir = await makeExtensionDir({ id: 'demo-ext' });
    const projectRoot = await makeTempDir();
    await writeProjectDeclaration(
      projectRoot,
      'api_version = 1\nmystery = true\n\n[[extension]]\nid = "demo-ext"\n',
    );
    const registry = new ExtensionRegistry({ localDirs: [{ path: dir }] });

    const report = await registry.resolveForProject(projectRoot);

    expect(report.warnings.map((warning) => warning.code)).toEqual(['unknown-field']);
    expect(report.resolved).toHaveLength(1);
  });

  it('re-parses BOTH files on every call — a version bump flips the resolution', async () => {
    const dir = await makeExtensionDir({ id: 'demo-ext', version: '1.4.2' });
    const projectRoot = await makeTempDir();
    await writeProjectDeclaration(
      projectRoot,
      '[[extension]]\nid = "demo-ext"\nversion = ">=1.2, <2"\n',
    );
    const registry = new ExtensionRegistry({ localDirs: [{ path: dir }] });

    expect((await registry.resolveForProject(projectRoot)).resolved).toHaveLength(1);

    // The extension moves to 2.0.0 …
    await writeFile(
      join(dir, MANIFEST_FILENAME),
      manifestText({ id: 'demo-ext', version: '2.0.0' }),
      'utf8',
    );
    const afterBump = await registry.resolveForProject(projectRoot);
    expect(afterBump.resolved).toEqual([]);
    expect(afterBump.unresolved[0]?.reason).toBe('version-mismatch');
    expect(afterBump.unresolved[0]?.installedVersion).toBe('2.0.0');

    // … and the project widens its range to follow.
    await writeProjectDeclaration(
      projectRoot,
      '[[extension]]\nid = "demo-ext"\nversion = ">=1.2, <3"\n',
    );
    const afterWiden = await registry.resolveForProject(projectRoot);
    expect(afterWiden.resolved).toHaveLength(1);
    expect(afterWiden.resolved[0]?.version).toBe('2.0.0');
  });

  it('resolves the real vimes-tasks fixture from a project declaration', async () => {
    const projectRoot = await makeTempDir();
    await writeProjectDeclaration(
      projectRoot,
      'api_version = 1\n\n[[extension]]\nid = "vimes-tasks"\nversion = "^1.0.0"\n',
    );
    const registry = new ExtensionRegistry({ localDirs: [{ path: VIMES_TASKS_FIXTURE }] });

    const report = await registry.resolveForProject(projectRoot);

    expect(report.resolved).toHaveLength(1);
    expect(report.resolved[0]?.version).toBe('1.0.0');
  });
});

describe('satisfiesVersionRange', () => {
  it('resolves comparator ranges', () => {
    expect(satisfiesVersionRange('1.4.2', '>=1.2, <2')).toBe(true);
    expect(satisfiesVersionRange('2.0.0', '>=1.2, <2')).toBe(false);
    expect(satisfiesVersionRange('1.2.0', '>1.2.0')).toBe(false);
    expect(satisfiesVersionRange('1.2.1', '>1.2.0')).toBe(true);
    expect(satisfiesVersionRange('1.2.0', '<=1.2.0')).toBe(true);
    expect(satisfiesVersionRange('1.2.3', '>=1.2 <2')).toBe(true);
  });

  it('resolves caret and tilde', () => {
    expect(satisfiesVersionRange('1.9.9', '^1.2.3')).toBe(true);
    expect(satisfiesVersionRange('2.0.0', '^1.2.3')).toBe(false);
    expect(satisfiesVersionRange('1.2.2', '^1.2.3')).toBe(false);
    // The leftmost NON-ZERO component is the one that may not change.
    expect(satisfiesVersionRange('0.2.9', '^0.2.3')).toBe(true);
    expect(satisfiesVersionRange('0.3.0', '^0.2.3')).toBe(false);
    expect(satisfiesVersionRange('0.0.4', '^0.0.3')).toBe(false);
    expect(satisfiesVersionRange('1.2.9', '~1.2.3')).toBe(true);
    expect(satisfiesVersionRange('1.3.0', '~1.2.3')).toBe(false);
    expect(satisfiesVersionRange('1.9.0', '~1')).toBe(true);
  });

  it('reads a partial or bare operand as a precision range', () => {
    expect(satisfiesVersionRange('1.2.9', '1.2')).toBe(true);
    expect(satisfiesVersionRange('1.3.0', '1.2')).toBe(false);
    expect(satisfiesVersionRange('1.0.0', '1.0.0')).toBe(true);
    expect(satisfiesVersionRange('1.0.1', '1.0.0')).toBe(false);
    expect(satisfiesVersionRange('9.9.9', '*')).toBe(true);
  });

  it('ORs alternatives across `||`', () => {
    expect(satisfiesVersionRange('3.1.0', '^1.0.0 || ^3.0.0')).toBe(true);
    expect(satisfiesVersionRange('2.1.0', '^1.0.0 || ^3.0.0')).toBe(false);
  });

  it('honours semver prerelease PRECEDENCE', () => {
    // semver.org §11.3 — a prerelease has lower precedence than its release.
    expect(satisfiesVersionRange('1.0.0-rc.1', '<1.0.0')).toBe(true);
    expect(satisfiesVersionRange('1.0.0-rc.1', '>=1.0.0')).toBe(false);
    expect(satisfiesVersionRange('1.0.0-rc.2', '>1.0.0-rc.1')).toBe(true);
    expect(satisfiesVersionRange('1.0.0-alpha.1', '>1.0.0-alpha')).toBe(true);
    expect(satisfiesVersionRange('1.0.0-alpha', '>1.0.0-1')).toBe(true);
  });

  it('returns null — not a guess — for something it cannot resolve', () => {
    expect(satisfiesVersionRange('1.0.0', 'sometime after tuesday')).toBeNull();
    expect(satisfiesVersionRange('not-a-version', '>=1.0.0')).toBeNull();
    expect(satisfiesVersionRange('1.0.0', '')).toBeNull();
  });
});
