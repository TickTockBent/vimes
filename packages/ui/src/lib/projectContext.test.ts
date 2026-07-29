import { describe, expect, it } from 'vitest';
import {
  cwdWithinProject,
  declarePrefill,
  describeDeclareResponse,
  initialHashFor,
  layoutStorageKey,
  parseProjectPath,
  projectDisplayName,
  resolveProject,
  type ProjectView,
} from './projectContext.js';

// ─── S8·2 — the project context (D61 + D42) ──────────────────────────────────

const PROJECTS_BASE = '/home/ticktockbent/projects';

function makeProject(overrides: Partial<ProjectView> = {}): ProjectView {
  return {
    projectId: 'project-1',
    root: `${PROJECTS_BASE}/infrastructure/johnny`,
    archived: false,
    pathSegment: 'infrastructure/johnny',
    ...overrides,
  };
}

describe('parseProjectPath', () => {
  it('reads the segment from an ordinary project path, with or without a trailing slash', () => {
    expect(parseProjectPath('/infrastructure/johnny/')).toBe('infrastructure/johnny');
    expect(parseProjectPath('/infrastructure/johnny')).toBe('infrastructure/johnny');
    expect(parseProjectPath('/vimes/')).toBe('vimes');
  });

  it('is null for the bare root — that is the picker, not a project', () => {
    expect(parseProjectPath('/')).toBeNull();
    expect(parseProjectPath('')).toBeNull();
    expect(parseProjectPath('///')).toBeNull();
  });

  it('DECODES percent-encoding, so a directory with a space is addressable', () => {
    expect(parseProjectPath('/games/space%20industry/')).toBe('games/space industry');
  });

  it('normalizes noise: doubled slashes and "." segments', () => {
    expect(parseProjectPath('//infrastructure//johnny//')).toBe('infrastructure/johnny');
    expect(parseProjectPath('/./infrastructure/./johnny/')).toBe('infrastructure/johnny');
  });

  it('HOSTILE INPUT: never emits a segment containing "..", encoded or not', () => {
    // The output builds URLs and prefills a path, so a climbing segment must not
    // survive in ANY form — and it is REFUSED, never resolved by climbing (which
    // would make two different URLs mean the same project).
    expect(parseProjectPath('/../etc/passwd')).toBeNull();
    expect(parseProjectPath('/infrastructure/../../etc/')).toBeNull();
    expect(parseProjectPath('/%2e%2e/etc/')).toBeNull();
    expect(parseProjectPath('/infrastructure/%2E%2E/johnny/')).toBeNull();
  });

  it('HOSTILE INPUT: a malformed escape is null, never the raw bytes', () => {
    expect(parseProjectPath('/%')).toBeNull();
    expect(parseProjectPath('/infra/%zz/')).toBeNull();
  });

  it('ignores a query or fragment a caller hands it by mistake', () => {
    expect(parseProjectPath('/infrastructure/johnny/?x=1')).toBe('infrastructure/johnny');
    expect(parseProjectPath('/infrastructure/johnny/#/session/abc')).toBe('infrastructure/johnny');
  });

  it('is total over long and strange input', () => {
    expect(parseProjectPath(`/${'a'.repeat(10_000)}/`)).toHaveLength(10_000);
    expect(parseProjectPath('/a b/c+d/')).toBe('a b/c+d');
  });
});

describe('resolveProject', () => {
  const johnny = makeProject();
  const vimes = makeProject({
    projectId: 'project-2',
    root: `${PROJECTS_BASE}/infrastructure/vimes`,
    pathSegment: 'infrastructure/vimes',
  });

  it('matches on pathSegment', () => {
    expect(resolveProject('infrastructure/vimes', [johnny, vimes])).toBe(vimes);
  });

  it('EXCLUDES ARCHIVED projects — an archived boundary claims no live work', () => {
    const archived = makeProject({ archived: true });
    expect(resolveProject('infrastructure/johnny', [archived])).toBeNull();
    // ...and a live re-declaration of the same directory DOES resolve, which is
    // what "archiving frees the root" means at the URL.
    expect(resolveProject('infrastructure/johnny', [archived, johnny])).toBe(johnny);
  });

  it('is null for a segment nothing claims — the declare-prefill door', () => {
    expect(resolveProject('infrastructure/not-declared', [johnny, vimes])).toBeNull();
    expect(resolveProject(null, [johnny])).toBeNull();
  });

  it('never matches the EMPTY segment, so a base-root project stays picker-only', () => {
    const baseItself = makeProject({ projectId: 'base', root: PROJECTS_BASE, pathSegment: '' });
    expect(resolveProject('', [baseItself])).toBeNull();
  });

  it('never matches a project with NO segment (its root fell outside the fence)', () => {
    const unaddressable = makeProject({ pathSegment: null });
    expect(resolveProject('infrastructure/johnny', [unaddressable])).toBeNull();
  });
});

describe('declarePrefill', () => {
  it('composes the absolute root the URL proposes', () => {
    expect(declarePrefill('infrastructure/newthing', [PROJECTS_BASE])).toBe(
      `${PROJECTS_BASE}/infrastructure/newthing`,
    );
  });

  it('does not double the separator when a base already ends in one', () => {
    expect(declarePrefill('newthing', [`${PROJECTS_BASE}/`])).toBe(`${PROJECTS_BASE}/newthing`);
  });

  it('uses the FIRST base only — picking among several is a decision, not a default', () => {
    expect(declarePrefill('thing', ['/srv/one', '/srv/two'])).toBe('/srv/one/thing');
  });

  it('is null with no bases and null with no segment', () => {
    expect(declarePrefill('thing', [])).toBeNull();
    expect(declarePrefill(null, [PROJECTS_BASE])).toBeNull();
    expect(declarePrefill('', [PROJECTS_BASE])).toBeNull();
  });
});

describe('describeDeclareResponse', () => {
  it('reports a declaration as declared', () => {
    expect(describeDeclareResponse(200, { project: {} }).kind).toBe('declared');
  });

  it('names the D60 FENCE on a 403 rather than a generic failure', () => {
    const outcome = describeDeclareResponse(403, { error: 'forbidden', detail: 'outside-roots' });
    expect(outcome.kind).toBe('refused');
    expect(outcome.sentence).toContain('project roots');
  });

  it('distinguishes the two 400 detail classes, and degrades honestly on an unknown one', () => {
    expect(describeDeclareResponse(400, { detail: 'no-such-directory' }).sentence).toContain(
      'No such directory',
    );
    expect(describeDeclareResponse(400, { detail: 'not-a-directory' }).sentence).toContain('a file');
    expect(describeDeclareResponse(400, { detail: 'schema' }).kind).toBe('refused');
  });

  it('reports a duplicate root as already declared', () => {
    expect(describeDeclareResponse(409, { detail: 'duplicate-root' }).sentence).toContain(
      'already a project',
    );
  });

  it('NEVER reads a transport failure (status 0) as a refusal the daemon made', () => {
    expect(describeDeclareResponse(0, null).sentence).toContain('never reached the daemon');
  });

  it('is total over an unknown status and a hostile body', () => {
    expect(describeDeclareResponse(500, 'not an object').sentence).toContain('500');
    expect(describeDeclareResponse(418, null).kind).toBe('refused');
  });
});

describe('cwdWithinProject — the mirror of core projectForCwd/isWithinProjectRoot', () => {
  // ⚠ THE TRAP TEST, kept IDENTICAL to the case core's own comment names as the
  // load-bearing line (packages/core/src/projections/projects.ts). This pair is
  // the binding between the two implementations: a bare startsWith passes every
  // other case in this file and fails only here.
  it('a SIBLING directory is NOT inside the project (vimes vs vimes-2)', () => {
    const vimesRoot = `${PROJECTS_BASE}/infrastructure/vimes`;
    expect(cwdWithinProject(`${PROJECTS_BASE}/infrastructure/vimes-2`, vimesRoot)).toBe(false);
    expect(cwdWithinProject(`${PROJECTS_BASE}/infrastructure/vimes-2/packages/ui`, vimesRoot)).toBe(
      false,
    );
    // The neighbouring project owns its own cwd, as it must.
    expect(
      cwdWithinProject(
        `${PROJECTS_BASE}/infrastructure/vimes-2`,
        `${PROJECTS_BASE}/infrastructure/vimes-2`,
      ),
    ).toBe(true);
  });

  it('the root ITSELF is inside the project', () => {
    const root = `${PROJECTS_BASE}/infrastructure/johnny`;
    expect(cwdWithinProject(root, root)).toBe(true);
    // A trailing slash on the cwd is a different string, and the guard treats it
    // as strictly beneath — still inside.
    expect(cwdWithinProject(`${root}/`, root)).toBe(true);
  });

  it('deep nesting is inside; a parent and an unrelated tree are not', () => {
    const root = `${PROJECTS_BASE}/infrastructure/johnny`;
    expect(cwdWithinProject(`${root}/packages/daemon/src`, root)).toBe(true);
    expect(cwdWithinProject(PROJECTS_BASE, root)).toBe(false);
    expect(cwdWithinProject('/srv/elsewhere', root)).toBe(false);
  });

  it('is false for empty input rather than matching everything', () => {
    expect(cwdWithinProject('', `${PROJECTS_BASE}/x`)).toBe(false);
    expect(cwdWithinProject(`${PROJECTS_BASE}/x`, '')).toBe(false);
  });
});

describe('projectDisplayName', () => {
  it('uses the declared name when there is one', () => {
    expect(projectDisplayName(makeProject({ name: 'Johnny' }))).toBe('Johnny');
  });

  it('FALLS BACK TO THE BASENAME when the record carries no name (D42)', () => {
    expect(projectDisplayName(makeProject())).toBe('johnny');
  });

  it('treats a whitespace-only name as no name', () => {
    expect(projectDisplayName(makeProject({ name: '   ' }))).toBe('johnny');
  });

  it('is never blank — a root that ends in slashes still yields its basename', () => {
    expect(projectDisplayName(makeProject({ root: `${PROJECTS_BASE}/johnny//` }))).toBe('johnny');
    expect(projectDisplayName(makeProject({ root: '/' }))).toBe('/');
  });
});

describe('layoutStorageKey', () => {
  it('is per PROJECT ID, so two projects cannot share a remembered layout', () => {
    expect(layoutStorageKey('abc')).toBe('vimes:layout:abc');
    expect(layoutStorageKey('abc')).not.toBe(layoutStorageKey('def'));
  });
});

describe('initialHashFor', () => {
  it('A DEEP LINK WINS over the remembered layout', () => {
    expect(initialHashFor('#/session/abc', '#/tasks')).toBe('#/session/abc');
  });

  it('falls back to the remembered layout when there is no hash', () => {
    expect(initialHashFor('', '#/tasks')).toBe('#/tasks');
    // A bare '#' is what an empty fragment leaves behind, not an instruction.
    expect(initialHashFor('#', '#/tasks')).toBe('#/tasks');
  });

  it('falls back to the DEFAULT view with neither', () => {
    expect(initialHashFor('', null)).toBe('');
    expect(initialHashFor('#', null)).toBe('');
  });

  it('IGNORES a stored value that is not a hash — storage is user-writable', () => {
    expect(initialHashFor('', 'https://evil.example/')).toBe('');
    expect(initialHashFor('', '')).toBe('');
    expect(initialHashFor('', '#')).toBe('');
  });
});
