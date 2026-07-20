import { Readable } from 'node:stream';
import { createReadStream } from 'node:fs';
import { readdir, stat, lstat, readFile, writeFile, rename, unlink, open } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import type { Hono } from 'hono';
import yazl from 'yazl';
import { resolveWithinRoots, realpathProbe, type RealpathProbe } from './filePaths.js';

// ─── File API (REST, behind the auth wall on the product port) ────────────────
//
// Scoped to `projectRoots ∪ live-session cwds` (the caller supplies the union via
// getAllowedRoots). EVERY request-derived path passes through resolveWithinRoots
// BEFORE any fs touch — a path-safety refusal is a 403 with zero product bytes.
// Refusals are plain text; auth is already in front (I14), so a shaped auth
// failure never reaches here.

export interface FileApiDeps {
  // The live allowlist union (config.projectRoots ∪ host.liveSessionCwds()),
  // read fresh per request so a newly-spawned session's cwd is immediately
  // reachable and a dead one's is not.
  getAllowedRoots: () => readonly string[];
  // Max bytes for content preview/edit and per uploaded file (config.maxEditBytes).
  maxEditBytes: number;
  // Injected realpath probe (fs boundary). Defaults to the real one; tests over
  // real mkdtemp trees use the default.
  realpath?: RealpathProbe;
}

// Null-byte sniff over a prefix: a 0x00 in the first slice classifies the file as
// binary so the editor can refuse-with-grace rather than corrupting it on save.
const BINARY_SNIFF_BYTES = 8192;
function looksBinary(prefix: Buffer): boolean {
  return prefix.includes(0);
}

// Content-Disposition filename: keep a conservative charset; strip anything that
// could break the header or smuggle a path. Never trust the request's basename.
function sanitizeDownloadName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '_').trim();
  return cleaned.length > 0 ? cleaned : 'download';
}

// Atomic write: a temp file in the SAME directory, then rename over the target
// (rename is atomic within a filesystem). On any failure the temp is removed, so
// a failed write never leaves a half-written file OR a stray temp behind.
export async function writeFileAtomic(absolutePath: string, data: Buffer): Promise<void> {
  const directory = dirname(absolutePath);
  const temporaryPath = join(directory, `.${basename(absolutePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temporaryPath, data, { flag: 'wx' });
    await rename(temporaryPath, absolutePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

type EntryType = 'dir' | 'file' | 'symlink';

// Recursively collect regular files under a directory for zipping, re-checking
// each against the allowlist and SKIPPING symlinks (never follow a link out of
// roots). Returns { absolute, relative } pairs; relative is the zip entry name.
async function collectZipEntries(
  directoryAbsolute: string,
  allowedRoots: readonly string[],
  realpath: RealpathProbe,
): Promise<Array<{ absolute: string; relative: string }>> {
  const collected: Array<{ absolute: string; relative: string }> = [];
  const rootName = basename(directoryAbsolute);
  async function walk(currentAbsolute: string, relativePrefix: string): Promise<void> {
    const entries = await readdir(currentAbsolute, { withFileTypes: true });
    for (const entry of entries) {
      const childAbsolute = join(currentAbsolute, entry.name);
      const childRelative = `${relativePrefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        continue; // never follow a symlink out of roots
      }
      // Re-validate every entry: a nested path must still resolve within a root.
      const resolved = resolveWithinRoots(childAbsolute, allowedRoots, realpath);
      if (!resolved.ok) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(childAbsolute, childRelative);
      } else if (entry.isFile()) {
        collected.push({ absolute: childAbsolute, relative: childRelative });
      }
    }
  }
  await walk(directoryAbsolute, rootName);
  return collected;
}

export function registerFileApi(app: Hono, deps: FileApiDeps): void {
  const realpath = deps.realpath ?? realpathProbe;

  // GET /api/files/tree?root=<r>&path=<p> — one level deep directory listing.
  app.get('/api/files/tree', async (context) => {
    const rootParam = context.req.query('root') ?? '';
    const pathParam = context.req.query('path') ?? '';
    const allowedRoots = deps.getAllowedRoots();
    // Resolve root+path to an absolute target within the allowlist.
    const requested = pathParam === '' ? rootParam : join(rootParam, pathParam);
    const resolved = resolveWithinRoots(requested, allowedRoots, realpath);
    if (!resolved.ok) {
      return context.text('forbidden', 403);
    }
    let stats;
    try {
      stats = await stat(resolved.absolute);
    } catch {
      return context.text('not found', 404);
    }
    if (!stats.isDirectory()) {
      return context.text('not a directory', 400);
    }
    const dirEntries = await readdir(resolved.absolute, { withFileTypes: true });
    const listed = await Promise.all(
      dirEntries.map(async (entry) => {
        const entryAbsolute = join(resolved.absolute, entry.name);
        let entryType: EntryType;
        let size = 0;
        let mtimeMs = 0;
        try {
          const entryStats = await lstat(entryAbsolute);
          entryType = entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'dir' : 'file';
          size = entryStats.size;
          mtimeMs = entryStats.mtimeMs;
        } catch {
          entryType = entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'dir' : 'file';
        }
        return {
          name: entry.name,
          type: entryType,
          size,
          mtime: mtimeMs,
          hidden: entry.name.startsWith('.'),
        };
      }),
    );
    return context.json({ root: rootParam, path: pathParam, absolute: resolved.absolute, entries: listed });
  });

  // GET /api/files/content?path=<p> — file bytes + mtime header + binary flag.
  app.get('/api/files/content', async (context) => {
    const pathParam = context.req.query('path') ?? '';
    const resolved = resolveWithinRoots(pathParam, deps.getAllowedRoots(), realpath);
    if (!resolved.ok) {
      return context.text('forbidden', 403);
    }
    let stats;
    try {
      stats = await stat(resolved.absolute);
    } catch {
      return context.text('not found', 404);
    }
    if (!stats.isFile()) {
      return context.text('not a file', 400);
    }
    if (stats.size > deps.maxEditBytes) {
      return context.text('file too large', 413);
    }
    const data = await readFile(resolved.absolute);
    const isBinary = looksBinary(data.subarray(0, BINARY_SNIFF_BYTES));
    return context.body(new Uint8Array(data), 200, {
      'content-type': isBinary ? 'application/octet-stream' : 'text/plain; charset=utf-8',
      'x-vimes-mtime': String(stats.mtimeMs),
      'x-vimes-binary': isBinary ? '1' : '0',
    });
  });

  // PUT /api/files/content — { path, content, expectedMtime } with mtime precondition.
  app.put('/api/files/content', async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.text('bad request', 400);
    }
    if (typeof body !== 'object' || body === null) {
      return context.text('bad request', 400);
    }
    const { path: pathValue, content, expectedMtime } = body as {
      path?: unknown;
      content?: unknown;
      expectedMtime?: unknown;
    };
    if (typeof pathValue !== 'string' || typeof content !== 'string') {
      return context.text('bad request', 400);
    }
    if (expectedMtime !== null && typeof expectedMtime !== 'number') {
      return context.text('bad request', 400);
    }
    const resolved = resolveWithinRoots(pathValue, deps.getAllowedRoots(), realpath);
    if (!resolved.ok) {
      return context.text('forbidden', 403);
    }
    const data = Buffer.from(content, 'utf8');
    if (data.byteLength > deps.maxEditBytes) {
      return context.text('file too large', 413);
    }
    let existing;
    try {
      existing = await stat(resolved.absolute);
    } catch {
      existing = null;
    }
    if (expectedMtime === null) {
      // New-file write: refuse if anything already exists at the path.
      if (existing !== null) {
        return context.text('already exists', 409);
      }
    } else {
      if (existing === null) {
        return context.text('not found', 404);
      }
      if (!existing.isFile()) {
        return context.text('not a file', 400);
      }
      // mtime precondition: a mismatch means the file changed under the client.
      // Return 409 + the CURRENT mtime so the client can re-confirm (last-write-
      // wins only after an explicit re-send with the fresh mtime; n=1 posture).
      if (existing.mtimeMs !== expectedMtime) {
        return context.body('conflict', 409, { 'x-vimes-mtime': String(existing.mtimeMs) });
      }
    }
    await writeFileAtomic(resolved.absolute, data);
    const written = await stat(resolved.absolute);
    return context.json({ ok: true, mtime: written.mtimeMs });
  });

  // GET /api/files/download?path=<p>[&zip=1] — single file, or a folder as a zip.
  app.get('/api/files/download', async (context) => {
    const pathParam = context.req.query('path') ?? '';
    const zipRequested = context.req.query('zip') === '1';
    const allowedRoots = deps.getAllowedRoots();
    const resolved = resolveWithinRoots(pathParam, allowedRoots, realpath);
    if (!resolved.ok) {
      return context.text('forbidden', 403);
    }
    let stats;
    try {
      stats = await stat(resolved.absolute);
    } catch {
      return context.text('not found', 404);
    }

    if (zipRequested) {
      if (!stats.isDirectory()) {
        return context.text('not a directory', 400);
      }
      const entries = await collectZipEntries(resolved.absolute, allowedRoots, realpath);
      const zipFile = new yazl.ZipFile();
      for (const entry of entries) {
        zipFile.addFile(entry.absolute, entry.relative);
      }
      zipFile.end();
      const zipName = `${sanitizeDownloadName(basename(resolved.absolute))}.zip`;
      // yazl types outputStream as NodeJS.ReadableStream; at runtime it is a Node
      // Readable (PassThrough), so adapt it to a web stream for Hono/node-server.
      const webStream = Readable.toWeb(zipFile.outputStream as unknown as Readable) as ReadableStream;
      return context.body(webStream, 200, {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${zipName}"`,
      });
    }

    if (!stats.isFile()) {
      return context.text('not a file', 400);
    }
    const fileName = sanitizeDownloadName(basename(resolved.absolute));
    const webStream = Readable.toWeb(createReadStream(resolved.absolute)) as ReadableStream;
    return context.body(webStream, 200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${fileName}"`,
      'content-length': String(stats.size),
    });
  });

  // POST /api/files/upload (multipart) — within-roots dest; per-file cap; refuses
  // overwrite unless an explicit overwrite=true field. Streaming upload is
  // post-MVP: an oversize file is rejected cleanly, never half-written.
  app.post('/api/files/upload', async (context) => {
    let form: FormData;
    try {
      form = await context.req.formData();
    } catch {
      return context.text('bad request', 400);
    }
    const pathValue = form.get('path');
    const fileValue = form.get('file');
    const overwrite = form.get('overwrite') === 'true';
    if (typeof pathValue !== 'string' || !(fileValue instanceof File)) {
      return context.text('bad request', 400);
    }
    const resolved = resolveWithinRoots(pathValue, deps.getAllowedRoots(), realpath);
    if (!resolved.ok) {
      return context.text('forbidden', 403);
    }
    // Per-file ceiling BEFORE any write (post-MVP streaming would raise this).
    if (fileValue.size > deps.maxEditBytes) {
      return context.text('file too large', 413);
    }
    // Refuse to clobber unless explicitly told to.
    let existing;
    try {
      existing = await open(resolved.absolute, 'r');
    } catch {
      existing = null;
    }
    if (existing !== null) {
      await existing.close();
      if (!overwrite) {
        return context.text('already exists', 409);
      }
    }
    const data = Buffer.from(await fileValue.arrayBuffer());
    // Overwrite path: writeFileAtomic uses `wx` for the temp (fresh name), then
    // rename replaces the target — so overwrite is still atomic.
    await writeFileAtomic(resolved.absolute, data);
    const written = await stat(resolved.absolute);
    return context.json({ ok: true, path: resolved.absolute, mtime: written.mtimeMs });
  });
}
