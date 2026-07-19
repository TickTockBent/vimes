import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { transcriptDirFor } from './transcriptPaths.js';

// ─── On-demand external-session discovery (D10, spec §3.2) ───────────────────
//
// A SCAN, never a watcher (the inotify budget is why ~/.claude/projects is never
// live-watched). It walks the encoded transcript dir of each configured project
// root and returns every *.jsonl file NOT already mapped to a known session. The
// caller (SessionHost) mints a mirrored `custody:'external'` session for each and
// registers the file with the tailer from current EOF — history backfill is
// post-MVP, so the resync marker is the honest signal (§3.2).
//
// The transcript-path encoding is reused verbatim (transcriptPaths.ts, the
// fragile-adapter boundary): discovery scans exactly `transcriptDirFor(root)` for
// each root, so only sessions whose cwd IS a project root surface (subdir cwds
// live in different encoded dirs — a documented limitation, not a bug).

export interface DiscoveredTranscript {
  cwd: string;
  jsonlPath: string;
  claudeSessionId: string;
}

export interface ScanDeps {
  projectRoots: readonly string[];
  projectsRoot: string;
  // Transcript files already owned by a known session (the sessions projection's
  // claudeSessionIds' jsonlPaths) — the idempotency guard: a re-scan never
  // re-mints a session for a file already mapped.
  knownJsonlPaths: ReadonlySet<string>;
  // Claude session ids already mapped — a second guard in case a file's path
  // differs but its id is already known.
  knownClaudeSessionIds: ReadonlySet<string>;
}

const JSONL_SUFFIX = '.jsonl';

export function scanForExternalTranscripts(deps: ScanDeps): DiscoveredTranscript[] {
  const discovered: DiscoveredTranscript[] = [];
  for (const root of deps.projectRoots) {
    const dir = transcriptDirFor(deps.projectsRoot, root);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      // The dir does not exist yet (no transcripts for this root) — nothing to
      // discover here; a future scan will find it once Claude writes one.
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(JSONL_SUFFIX)) {
        continue;
      }
      const jsonlPath = join(dir, entry);
      const claudeSessionId = entry.slice(0, -JSONL_SUFFIX.length);
      if (deps.knownJsonlPaths.has(jsonlPath) || deps.knownClaudeSessionIds.has(claudeSessionId)) {
        continue;
      }
      discovered.push({ cwd: root, jsonlPath, claudeSessionId });
    }
  }
  return discovered;
}
