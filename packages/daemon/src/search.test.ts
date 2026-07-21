import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, type RawData } from 'ws';
import { CountingIdSource, SteppingClock } from '@vimes/core';
import type { AccessVerifier } from './auth.js';
import { createDaemon, type Daemon } from './app.js';
import type { DaemonConfig } from './config.js';
import type { RipgrepSpawner, RipgrepProcess } from './search.js';

// ─── Search + preview-gated replace over a live daemon (protocol v0.4) ────────
//
// ripgrep is an injected seam. The behavioral tests use a fake that emits
// OBSERVED-shape `--json` frames (captured from real ripgrep 14.1.1 on this box:
// begin/match/end/summary) by scanning the REAL mkdtemp tree — so the parser is
// exercised against the true protocol shape while cancel + failure injection stay
// deterministic. A guarded verify-row runs the REAL `rg` when a spawnable binary
// is present (skipped otherwise — see the step's finding).

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'vimes-search-'));
let databaseFileCounter = 0;

const permissiveVerifier: AccessVerifier = { verify: async () => ({ ok: true }) };
const ANY_TOKEN = 'valid-token-stub';

function nextDatabasePath(): string {
  databaseFileCounter += 1;
  return join(temporaryDirectory, `search-${databaseFileCounter}.db`);
}

function makeRoot(label: string): string {
  return realpathSync(mkdtempSync(join(temporaryDirectory, `${label}-`)));
}

function buildConfig(projectRoots: string[]): DaemonConfig {
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
    maxEditBytes: 5 * 1024 * 1024,
    terminalIdleReapMs: 0,
    usagePollIntervalMs: 0,
    usageBaseUrl: 'http://usage.invalid',
    usageAlertPercents: [],
    usageForcedRefreshMinIntervalMs: 0,
  };
}

// ── the fake ripgrep: emits OBSERVED-shape --json frames over the real tree ──
interface FakeControls {
  // 'stream' emits results then closes; 'hang' emits results then stays open (for
  // cancel); 'enoent' fires an ENOENT error; 'fail' fires a generic error.
  mode?: 'stream' | 'hang' | 'enoent' | 'fail';
  killed: { value: boolean };
}

function walkFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkFiles(full));
    } else if (entry.isFile()) {
      found.push(full);
    }
  }
  return found;
}

// Build begin/match/end frames for one file, matching the captured real shape.
function framesForFile(absolutePath: string, query: string): string[] {
  const content = readFileSync(absolutePath, 'utf8');
  const lines = content.split('\n');
  const matchFrames: string[] = [];
  let matchCount = 0;
  lines.forEach((lineText, index) => {
    const column = lineText.indexOf(query);
    if (column < 0) {
      return;
    }
    matchCount += 1;
    matchFrames.push(
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: absolutePath },
          lines: { text: `${lineText}\n` },
          line_number: index + 1,
          absolute_offset: 0,
          submatches: [{ match: { text: query }, start: column, end: column + query.length }],
        },
      }),
    );
  });
  if (matchCount === 0) {
    return [];
  }
  return [
    JSON.stringify({ type: 'begin', data: { path: { text: absolutePath } } }),
    ...matchFrames,
    JSON.stringify({
      type: 'end',
      data: { path: { text: absolutePath }, binary_offset: null, stats: { matches: matchCount } },
    }),
  ];
}

function makeFakeRipgrep(controls: FakeControls): RipgrepSpawner {
  return (args, cwd): RipgrepProcess => {
    const dashDash = args.indexOf('--');
    const query = args[dashDash + 1] ?? '';
    const searchRoot = args[dashDash + 2] ?? cwd;
    let lineCallback: ((line: string) => void) | undefined;
    let closeCallback: ((code: number | null) => void) | undefined;
    let errorCallback: ((error: NodeJS.ErrnoException) => void) | undefined;
    let done = false;

    queueMicrotask(() => {
      const mode = controls.mode ?? 'stream';
      if (mode === 'enoent') {
        const error = new Error('spawn rg ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        errorCallback?.(error);
        return;
      }
      if (mode === 'fail') {
        const error = new Error('rg blew up') as NodeJS.ErrnoException;
        error.code = 'EPIPE';
        errorCallback?.(error);
        return;
      }
      const frames: string[] = [];
      for (const filePath of walkFiles(searchRoot).sort()) {
        frames.push(...framesForFile(filePath, query));
      }
      frames.push(JSON.stringify({ data: { stats: { matches: frames.length } }, type: 'summary' }));
      for (const frame of frames) {
        if (controls.killed.value) {
          break;
        }
        lineCallback?.(frame);
      }
      if (mode === 'hang') {
        return; // stay open until killed (cancel test)
      }
      done = true;
      closeCallback?.(0);
    });

    return {
      onStdoutLine: (callback) => {
        lineCallback = callback;
      },
      onClose: (callback) => {
        closeCallback = callback;
      },
      onError: (callback) => {
        errorCallback = callback;
      },
      kill: () => {
        controls.killed.value = true;
        if (!done) {
          done = true;
          closeCallback?.(null);
        }
      },
    };
  };
}

function startDaemon(
  config: DaemonConfig,
  overrides: Partial<Parameters<typeof createDaemon>[0]> = {},
): Promise<Daemon> {
  const daemon = createDaemon({
    config,
    clock: new SteppingClock('2026-01-01T00:00:00.000Z', 1000),
    ids: new CountingIdSource(),
    verifier: permissiveVerifier,
    ripgrepPreflight: () => true,
    ...overrides,
  });
  return daemon.start().then(() => daemon);
}

interface OutboundMessage {
  op: string;
  [key: string]: unknown;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitUntil timed out');
    }
    await delay(10);
  }
}

class WsTestClient {
  readonly socket: WebSocket;
  readonly messages: OutboundMessage[] = [];
  constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { 'cf-access-jwt-assertion': ANY_TOKEN },
    });
    this.socket.on('message', (rawData: RawData) => {
      this.messages.push(JSON.parse(rawData.toString()) as OutboundMessage);
    });
  }
  opened(): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      this.socket.once('open', () => resolvePromise());
      this.socket.once('error', rejectPromise);
    });
  }
  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }
  of(op: string): OutboundMessage[] {
    return this.messages.filter((message) => message.op === op);
  }
  close(): void {
    this.socket.close();
  }
}

afterAll(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('Search — streaming shape + done stats', () => {
  it('streams search_result per match then search_done with matched/files/elapsedMs', async () => {
    const root = makeRoot('stream');
    writeFileSync(join(root, 'one.txt'), 'alpha NEEDLE beta\nno match\nNEEDLE again\n');
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'two.txt'), 'NEEDLE here\n');
    writeFileSync(join(root, 'three.txt'), 'nothing\n');
    const daemon = await startDaemon(buildConfig([root]), {
      ripgrepSpawner: makeFakeRipgrep({ killed: { value: false } }),
    });
    const client = new WsTestClient(daemon.port);
    try {
      await client.opened();
      client.send({ op: 'search', searchId: 's1', root, query: 'NEEDLE' });
      await waitUntil(() => client.of('search_done').length === 1);
      const results = client.of('search_result');
      expect(results.length).toBe(3); // two in one.txt, one in sub/two.txt
      const firstResult = results[0]!;
      expect(firstResult.searchId).toBe('s1');
      expect(typeof firstResult.line).toBe('number');
      expect(Array.isArray(firstResult.submatches)).toBe(true);
      const done = client.of('search_done')[0]!;
      const stats = done.stats as { matched: number; files: number; elapsedMs: number };
      expect(stats.matched).toBe(3);
      expect(stats.files).toBe(2);
      expect(typeof stats.elapsedMs).toBe('number');
    } finally {
      client.close();
      await daemon.stop();
    }
  });

  it('refuses a root outside the allowlist with search_error (no spawn)', async () => {
    const root = makeRoot('allow');
    const outside = makeRoot('outside');
    const daemon = await startDaemon(buildConfig([root]), {
      ripgrepSpawner: makeFakeRipgrep({ killed: { value: false } }),
    });
    const client = new WsTestClient(daemon.port);
    try {
      await client.opened();
      client.send({ op: 'search', searchId: 's1', root: outside, query: 'x' });
      await waitUntil(() => client.of('search_error').length === 1);
      expect(client.of('search_error')[0]!.reason).toBe('root-outside-allowlist');
    } finally {
      client.close();
      await daemon.stop();
    }
  });
});

describe('Search — cancel + ripgrep-absent', () => {
  it('cancel mid-stream kills the rg process and emits no search_done', async () => {
    const root = makeRoot('cancel');
    writeFileSync(join(root, 'big.txt'), Array.from({ length: 50 }, () => 'NEEDLE line').join('\n'));
    const controls = { killed: { value: false }, mode: 'hang' as const };
    const daemon = await startDaemon(buildConfig([root]), { ripgrepSpawner: makeFakeRipgrep(controls) });
    const client = new WsTestClient(daemon.port);
    try {
      await client.opened();
      client.send({ op: 'search', searchId: 's1', root, query: 'NEEDLE' });
      await waitUntil(() => client.of('search_result').length > 0);
      client.send({ op: 'search_cancel', searchId: 's1' });
      await waitUntil(() => controls.killed.value === true);
      await delay(50); // give any (erroneous) search_done a chance to arrive
      expect(controls.killed.value).toBe(true);
      expect(client.of('search_done').length).toBe(0);
    } finally {
      client.close();
      await daemon.stop();
    }
  });

  it('reports search_error ripgrep-unavailable when the preflight says rg is absent', async () => {
    const root = makeRoot('norg');
    const daemon = await startDaemon(buildConfig([root]), { ripgrepPreflight: () => false });
    const client = new WsTestClient(daemon.port);
    try {
      await client.opened();
      client.send({ op: 'search', searchId: 's1', root, query: 'x' });
      await waitUntil(() => client.of('search_error').length === 1);
      expect(client.of('search_error')[0]!.reason).toBe('ripgrep-unavailable');
    } finally {
      client.close();
      await daemon.stop();
    }
  });

  it('reports search_error ripgrep-unavailable when the spawn errors ENOENT', async () => {
    const root = makeRoot('enoent');
    writeFileSync(join(root, 'a.txt'), 'x\n');
    const daemon = await startDaemon(buildConfig([root]), {
      ripgrepSpawner: makeFakeRipgrep({ killed: { value: false }, mode: 'enoent' }),
    });
    const client = new WsTestClient(daemon.port);
    try {
      await client.opened();
      client.send({ op: 'search', searchId: 's1', root, query: 'x' });
      await waitUntil(() => client.of('search_error').length === 1);
      expect(client.of('search_error')[0]!.reason).toBe('ripgrep-unavailable');
    } finally {
      client.close();
      await daemon.stop();
    }
  });
});

describe('Replace — preview → apply round-trip + change guard', () => {
  it('previews per-file hunks, then applies atomically, replacing the text on disk', async () => {
    const root = makeRoot('replace');
    const target = join(root, 'code.txt');
    writeFileSync(target, 'const OLD = 1;\nkeep me\nreturn OLD + OLD;\n');
    const daemon = await startDaemon(buildConfig([root]), {
      ripgrepSpawner: makeFakeRipgrep({ killed: { value: false } }),
    });
    const client = new WsTestClient(daemon.port);
    try {
      await client.opened();
      client.send({ op: 'replace_preview', searchId: 's1', root, query: 'OLD', replacement: 'NEW' });
      await waitUntil(() => client.of('replace_preview_result').length === 1);
      const preview = client.of('replace_preview_result')[0]!;
      const previewId = preview.previewId as string;
      const files = preview.files as Array<{ path: string; hunks: unknown[]; previewHash: string }>;
      expect(files.length).toBe(1);
      expect(files[0]!.hunks.length).toBe(2); // two changed lines
      // Not yet applied.
      expect(readFileSync(target, 'utf8')).toContain('OLD');

      client.send({ op: 'replace_apply', previewId });
      await waitUntil(() => client.of('replace_applied').length === 1);
      expect(client.of('replace_applied')[0]!.filesChanged).toBe(1);
      expect(readFileSync(target, 'utf8')).toBe('const NEW = 1;\nkeep me\nreturn NEW + NEW;\n');
      expect(readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false);
    } finally {
      client.close();
      await daemon.stop();
    }
  });

  it('refuses replace_apply when a file changed between preview and apply (no blind apply)', async () => {
    const root = makeRoot('drift');
    const target = join(root, 'code.txt');
    writeFileSync(target, 'value OLD here\n');
    const daemon = await startDaemon(buildConfig([root]), {
      ripgrepSpawner: makeFakeRipgrep({ killed: { value: false } }),
    });
    const client = new WsTestClient(daemon.port);
    try {
      await client.opened();
      client.send({ op: 'replace_preview', searchId: 's1', root, query: 'OLD', replacement: 'NEW' });
      await waitUntil(() => client.of('replace_preview_result').length === 1);
      const previewId = client.of('replace_preview_result')[0]!.previewId as string;
      // Mutate the file AFTER the preview — the apply must refuse.
      writeFileSync(target, 'value OLD here changed\n');
      client.send({ op: 'replace_apply', previewId });
      await waitUntil(() => client.of('replace_error').length === 1);
      expect(client.of('replace_error')[0]!.reason).toBe('file-changed');
      // The file keeps the human's change; the stale replacement never landed.
      expect(readFileSync(target, 'utf8')).toBe('value OLD here changed\n');
    } finally {
      client.close();
      await daemon.stop();
    }
  });
});

// ── the fragile-adapter verify-row (rule 0.6): REAL ripgrep, when present ──────
// On a box with a spawnable `rg`, this proves the parser handles genuine
// ripgrep --json output. It is SKIPPED where rg is not a spawnable binary (the
// step's finding: this box's `rg` is a Claude Code shell shim).
const realRipgrepAvailable = (() => {
  const probe = spawnSync('rg', ['--version']);
  return probe.error === undefined && probe.status === 0;
})();

describe('Search — real ripgrep verify-row', () => {
  it.skipIf(!realRipgrepAvailable)('streams real rg --json matches over a mkdtemp tree', async () => {
    const root = makeRoot('realrg');
    writeFileSync(join(root, 'r.txt'), 'REALTARGET one\nnope\nREALTARGET two\n');
    const daemon = await startDaemon(buildConfig([root])); // real spawner + real preflight
    const client = new WsTestClient(daemon.port);
    try {
      await client.opened();
      client.send({ op: 'search', searchId: 's1', root, query: 'REALTARGET' });
      await waitUntil(() => client.of('search_done').length === 1, 5000);
      expect(client.of('search_result').length).toBe(2);
    } finally {
      client.close();
      await daemon.stop();
    }
  });
});
