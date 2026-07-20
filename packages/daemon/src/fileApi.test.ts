import { afterAll, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  statSync,
  rmSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CountingIdSource, SteppingClock } from '@vimes/core';
import type { AccessVerifier } from './auth.js';
import { createDaemon, type Daemon } from './app.js';
import type { DaemonConfig } from './config.js';

// ─── File API over a live daemon + real mkdtemp roots (spec §3.4/§3.11) ───────

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'vimes-fileapi-'));
let databaseFileCounter = 0;

const permissiveVerifier: AccessVerifier = { verify: async () => ({ ok: true }) };
const ANY_TOKEN = 'valid-token-stub';
const FIVE_MB = 5 * 1024 * 1024;

function nextDatabasePath(): string {
  databaseFileCounter += 1;
  return join(temporaryDirectory, `fileapi-${databaseFileCounter}.db`);
}

function buildConfig(projectRoots: string[], overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    port: 0,
    hookPort: 0,
    dbPath: nextDatabasePath(),
    dataDir: temporaryDirectory,
    expectedCliVersion: undefined,
    snapshotIntervalMs: 60_000,
    accessTeamDomain: undefined,
    accessAud: undefined,
    staticDir: undefined,
    wsBufferedLimitBytes: 4_194_304,
    bindHost: '127.0.0.1',
    sdkSettingSources: ['project'],
    projectRoots,
    pushSubject: 'mailto:test@example.invalid',
    maxEditBytes: FIVE_MB,
    ...overrides,
  };
}

function startDaemon(config: DaemonConfig): Promise<Daemon> {
  const daemon = createDaemon({
    config,
    clock: new SteppingClock('2026-01-01T00:00:00.000Z', 1000),
    ids: new CountingIdSource(),
    verifier: permissiveVerifier,
  });
  return daemon.start().then(() => daemon);
}

interface FetchInit {
  method?: string;
  body?: BodyInit;
  headers?: Record<string, string>;
}

function apiFetch(daemon: Daemon, path: string, init: FetchInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${daemon.port}${path}`, {
    method: init.method ?? 'GET',
    body: init.body,
    headers: { 'cf-access-jwt-assertion': ANY_TOKEN, ...(init.headers ?? {}) },
  });
}

// A fresh, isolated project root with a small tree for one test.
function makeRoot(label: string): string {
  return realpathSync(mkdtempSync(join(temporaryDirectory, `${label}-`)));
}

afterAll(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('File API — tree', () => {
  it('lists a directory one level deep, flagging hidden entries and typing symlinks', async () => {
    const root = makeRoot('tree');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, '.hidden'), 'secret-ish\n');
    symlinkSync(join(root, 'src'), join(root, 'srclink'));
    const daemon = await startDaemon(buildConfig([root]));
    try {
      const response = await apiFetch(daemon, `/api/files/tree?root=${encodeURIComponent(root)}&path=`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        entries: Array<{ name: string; type: string; hidden: boolean; size: number; mtime: number }>;
      };
      const byName = new Map(body.entries.map((entry) => [entry.name, entry]));
      expect(byName.get('src')?.type).toBe('dir');
      expect(byName.get('.hidden')?.hidden).toBe(true);
      expect(byName.get('srclink')?.type).toBe('symlink');
      expect(typeof byName.get('.hidden')?.mtime).toBe('number');
    } finally {
      await daemon.stop();
    }
  });
});

describe('File API — content GET', () => {
  it('returns file bytes with an mtime header and a binary=0 flag for text', async () => {
    const root = makeRoot('content');
    const target = join(root, 'hello.txt');
    writeFileSync(target, 'hello world\n');
    const daemon = await startDaemon(buildConfig([root]));
    try {
      const response = await apiFetch(daemon, `/api/files/content?path=${encodeURIComponent(target)}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('x-vimes-binary')).toBe('0');
      expect(response.headers.get('x-vimes-mtime')).toBe(String(statSync(target).mtimeMs));
      expect(await response.text()).toBe('hello world\n');
    } finally {
      await daemon.stop();
    }
  });

  it('flags a file with a NUL byte as binary=1', async () => {
    const root = makeRoot('binary');
    const target = join(root, 'blob.bin');
    writeFileSync(target, Buffer.from([0x50, 0x00, 0x51, 0x52]));
    const daemon = await startDaemon(buildConfig([root]));
    try {
      const response = await apiFetch(daemon, `/api/files/content?path=${encodeURIComponent(target)}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('x-vimes-binary')).toBe('1');
    } finally {
      await daemon.stop();
    }
  });

  it('refuses a non-file (400) and an oversize file (413)', async () => {
    const root = makeRoot('oversize');
    const dirTarget = join(root, 'adir');
    mkdirSync(dirTarget);
    const bigTarget = join(root, 'big.txt');
    writeFileSync(bigTarget, 'x'.repeat(64));
    const daemon = await startDaemon(buildConfig([root], { maxEditBytes: 16 }));
    try {
      const dirResponse = await apiFetch(daemon, `/api/files/content?path=${encodeURIComponent(dirTarget)}`);
      expect(dirResponse.status).toBe(400);
      const bigResponse = await apiFetch(daemon, `/api/files/content?path=${encodeURIComponent(bigTarget)}`);
      expect(bigResponse.status).toBe(413);
    } finally {
      await daemon.stop();
    }
  });
});

describe('File API — content PUT (mtime precondition + atomic write)', () => {
  it('writes an existing file when expectedMtime matches, returns the new mtime, leaves no temp', async () => {
    const root = makeRoot('put');
    const target = join(root, 'edit.txt');
    writeFileSync(target, 'v1\n');
    const currentMtime = statSync(target).mtimeMs;
    const daemon = await startDaemon(buildConfig([root]));
    try {
      const response = await apiFetch(daemon, '/api/files/content', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: target, content: 'v2 body\n', expectedMtime: currentMtime }),
      });
      expect(response.status).toBe(200);
      expect(readFileSync(target, 'utf8')).toBe('v2 body\n');
      expect(readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false);
    } finally {
      await daemon.stop();
    }
  });

  it('409s on a stale mtime and returns the current mtime; the file is NOT modified and no temp remains', async () => {
    const root = makeRoot('conflict');
    const target = join(root, 'edit.txt');
    writeFileSync(target, 'original\n');
    const daemon = await startDaemon(buildConfig([root]));
    try {
      const response = await apiFetch(daemon, '/api/files/content', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: target, content: 'clobber\n', expectedMtime: 12345 }),
      });
      expect(response.status).toBe(409);
      expect(response.headers.get('x-vimes-mtime')).toBe(String(statSync(target).mtimeMs));
      expect(readFileSync(target, 'utf8')).toBe('original\n');
      expect(readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false);
    } finally {
      await daemon.stop();
    }
  });

  it('creates a new file with expectedMtime null, and refuses (409) if it already exists — no temp left', async () => {
    const root = makeRoot('newfile');
    const daemon = await startDaemon(buildConfig([root]));
    try {
      const created = await apiFetch(daemon, '/api/files/content', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: join(root, 'fresh.txt'), content: 'brand new\n', expectedMtime: null }),
      });
      expect(created.status).toBe(200);
      expect(readFileSync(join(root, 'fresh.txt'), 'utf8')).toBe('brand new\n');

      const refused = await apiFetch(daemon, '/api/files/content', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: join(root, 'fresh.txt'), content: 'again\n', expectedMtime: null }),
      });
      expect(refused.status).toBe(409);
      expect(readFileSync(join(root, 'fresh.txt'), 'utf8')).toBe('brand new\n');
      expect(readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false);
    } finally {
      await daemon.stop();
    }
  });
});

describe('File API — download (single + zip)', () => {
  it('streams a single file as an attachment', async () => {
    const root = makeRoot('dl');
    const target = join(root, 'report.txt');
    writeFileSync(target, 'download me\n');
    const daemon = await startDaemon(buildConfig([root]));
    try {
      const response = await apiFetch(daemon, `/api/files/download?path=${encodeURIComponent(target)}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toContain('report.txt');
      expect(await response.text()).toBe('download me\n');
    } finally {
      await daemon.stop();
    }
  });

  it('zips a folder (?zip=1); the archive unzips to the original tree, symlinks skipped', async () => {
    const root = makeRoot('zip');
    const folder = join(root, 'bundle');
    mkdirSync(folder);
    mkdirSync(join(folder, 'nested'));
    writeFileSync(join(folder, 'top.txt'), 'top content\n');
    writeFileSync(join(folder, 'nested', 'deep.txt'), 'deep content\n');
    // A symlink inside the folder must be SKIPPED (never zipped/followed).
    symlinkSync(join(root, 'bundle', 'top.txt'), join(folder, 'link.txt'));
    const daemon = await startDaemon(buildConfig([root]));
    try {
      const response = await apiFetch(daemon, `/api/files/download?path=${encodeURIComponent(folder)}&zip=1`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/zip');
      const zipBytes = Buffer.from(await response.arrayBuffer());
      const zipPath = join(root, 'out.zip');
      writeFileSync(zipPath, zipBytes);
      const extractDir = join(root, 'extracted');
      mkdirSync(extractDir);
      execFileSync('unzip', ['-o', zipPath, '-d', extractDir]);
      expect(readFileSync(join(extractDir, 'bundle', 'top.txt'), 'utf8')).toBe('top content\n');
      expect(readFileSync(join(extractDir, 'bundle', 'nested', 'deep.txt'), 'utf8')).toBe('deep content\n');
      // The symlink entry was skipped — no link.txt in the archive.
      const listing = execFileSync('unzip', ['-Z1', zipPath]).toString();
      expect(listing).not.toContain('link.txt');
    } finally {
      await daemon.stop();
    }
  });
});

describe('File API — upload (multipart)', () => {
  it('accepts a file within roots, refuses overwrite without the flag, allows it with overwrite=true', async () => {
    const root = makeRoot('upload');
    const daemon = await startDaemon(buildConfig([root]));
    try {
      const destination = join(root, 'uploaded.txt');
      const firstForm = new FormData();
      firstForm.set('path', destination);
      firstForm.set('file', new File(['first payload\n'], 'uploaded.txt'));
      const first = await apiFetch(daemon, '/api/files/upload', { method: 'POST', body: firstForm });
      expect(first.status).toBe(200);
      expect(readFileSync(destination, 'utf8')).toBe('first payload\n');

      const secondForm = new FormData();
      secondForm.set('path', destination);
      secondForm.set('file', new File(['second payload\n'], 'uploaded.txt'));
      const refused = await apiFetch(daemon, '/api/files/upload', { method: 'POST', body: secondForm });
      expect(refused.status).toBe(409);
      expect(readFileSync(destination, 'utf8')).toBe('first payload\n');

      const overwriteForm = new FormData();
      overwriteForm.set('path', destination);
      overwriteForm.set('file', new File(['third payload\n'], 'uploaded.txt'));
      overwriteForm.set('overwrite', 'true');
      const overwritten = await apiFetch(daemon, '/api/files/upload', { method: 'POST', body: overwriteForm });
      expect(overwritten.status).toBe(200);
      expect(readFileSync(destination, 'utf8')).toBe('third payload\n');
    } finally {
      await daemon.stop();
    }
  });

  it('refuses an oversize upload (413) and writes nothing', async () => {
    const root = makeRoot('upbig');
    const daemon = await startDaemon(buildConfig([root], { maxEditBytes: 16 }));
    try {
      const destination = join(root, 'toobig.txt');
      const form = new FormData();
      form.set('path', destination);
      form.set('file', new File(['x'.repeat(64)], 'toobig.txt'));
      const response = await apiFetch(daemon, '/api/files/upload', { method: 'POST', body: form });
      expect(response.status).toBe(413);
      expect(readdirSync(root)).not.toContain('toobig.txt');
    } finally {
      await daemon.stop();
    }
  });
});

// ─── Hostile: traversal on EVERY endpoint → 403, zero read/write outside root ──
describe('File API — hostile traversal probes (the §3.11 wall)', () => {
  it('every endpoint refuses a traversal/symlink/absolute-escape with 403 and never touches the outside file', async () => {
    const root = makeRoot('hostile-root');
    writeFileSync(join(root, 'inside.txt'), 'inside\n');
    // The secret lives OUTSIDE the root; nothing must read or overwrite it.
    const outside = makeRoot('hostile-outside');
    const secretPath = join(outside, 'secret.txt');
    writeFileSync(secretPath, 'TOP SECRET\n');
    // A symlink INSIDE the root pointing OUT of it (the escape vector).
    symlinkSync(outside, join(root, 'escape'));
    const daemon = await startDaemon(buildConfig([root]));

    const escapePaths = [
      secretPath, // absolute outside root
      join(root, '..', 'hostile-outside', 'secret.txt'), // ../ traversal
      join(root, 'escape', 'secret.txt'), // through the symlink
    ];

    try {
      // tree
      for (const escape of escapePaths) {
        const response = await apiFetch(
          daemon,
          `/api/files/tree?root=${encodeURIComponent(escape)}&path=`,
        );
        expect(response.status).toBe(403);
      }
      // content GET
      for (const escape of escapePaths) {
        const response = await apiFetch(daemon, `/api/files/content?path=${encodeURIComponent(escape)}`);
        expect(response.status).toBe(403);
      }
      // download
      for (const escape of escapePaths) {
        const response = await apiFetch(daemon, `/api/files/download?path=${encodeURIComponent(escape)}`);
        expect(response.status).toBe(403);
      }
      // content PUT — must not overwrite the outside secret
      for (const escape of escapePaths) {
        const response = await apiFetch(daemon, '/api/files/content', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: escape, content: 'PWNED\n', expectedMtime: null }),
        });
        expect(response.status).toBe(403);
      }
      // upload — must not write the outside secret
      for (const escape of escapePaths) {
        const form = new FormData();
        form.set('path', escape);
        form.set('file', new File(['PWNED\n'], 'secret.txt'));
        form.set('overwrite', 'true');
        const response = await apiFetch(daemon, '/api/files/upload', { method: 'POST', body: form });
        expect(response.status).toBe(403);
      }

      // The outside secret is byte-for-byte untouched: no read leaked it, no write
      // reached it.
      expect(readFileSync(secretPath, 'utf8')).toBe('TOP SECRET\n');
    } finally {
      await daemon.stop();
    }
  });

  it('with an EMPTY allowlist (no roots, no live sessions) every read is refused 403', async () => {
    const root = makeRoot('noroots');
    const target = join(root, 'file.txt');
    writeFileSync(target, 'data\n');
    const daemon = await startDaemon(buildConfig([])); // no project roots
    try {
      const response = await apiFetch(daemon, `/api/files/content?path=${encodeURIComponent(target)}`);
      expect(response.status).toBe(403);
    } finally {
      await daemon.stop();
    }
  });
});
