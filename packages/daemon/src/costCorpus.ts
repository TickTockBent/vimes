import { open, readdir, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';

// ─── slice 5b step 1 — the cost-ledger corpus reader ─────────────────────────
//
// Reads Claude Code's TRANSCRIPTS (not VIMES's event log) and emits normalized
// usage rows. Settled by the spawn-path check (calibration.md 2026-07-21): the
// tailer attaches at current head, so the event log holds only what VIMES was
// watching, and terminals are not evented at all (rule 0.8). The event log is
// authoritative for LIVE state and wrong for ACCOUNTING.
//
// This module is I/O, so it lives in the daemon (rule 0.3). It does NO pricing,
// NO rollups and NO tree building — step 1's whole job is to emit the RIGHT ROW
// SET, because everything downstream prices whatever it is handed.
//
// The layout it walks:
//   <projectsRoot>/<slug>/<sessionId>.jsonl                          session
//   <projectsRoot>/<slug>/<sessionId>/subagents/agent-*.jsonl        subagent
//   <projectsRoot>/<slug>/<sessionId>/subagents/workflows/wf_*/…     ALSO subagent
// A non-recursive glob misses the workflow tier entirely (272 of 593 files at
// survey time) and under-reports one project by 232M tokens.

// ── the injectable filesystem seam ───────────────────────────────────────────
// Mirrors search.ts's ripgrep spawner and gitAdapter.ts's runner: the default is
// real fs, and tests inject a fake so they never touch ~/.claude.
export interface CorpusDirectoryEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

export interface CorpusFileStat {
  sizeBytes: number;
  mtimeMs: number;
}

export interface CorpusFileSystem {
  listDirectory(directoryPath: string): Promise<CorpusDirectoryEntry[]>;
  statFile(filePath: string): Promise<CorpusFileStat>;
  // utf8 text from `fromByteOffset` to whatever EOF is at read time. The file may
  // grow while this runs — the caller only consumes COMPLETE lines, so a record
  // half-written underneath us is left for the next scan.
  readTextFrom(filePath: string, fromByteOffset: number): Promise<string>;
}

const FILE_READ_CHUNK_BYTES = 1024 * 1024;

export const nodeCorpusFileSystem: CorpusFileSystem = {
  async listDirectory(directoryPath: string): Promise<CorpusDirectoryEntry[]> {
    const directoryEntries = await readdir(directoryPath, { withFileTypes: true });
    return directoryEntries.map((directoryEntry) => ({
      name: directoryEntry.name,
      isDirectory: directoryEntry.isDirectory(),
      isFile: directoryEntry.isFile(),
    }));
  },
  async statFile(filePath: string): Promise<CorpusFileStat> {
    const fileStats = await stat(filePath);
    return { sizeBytes: fileStats.size, mtimeMs: fileStats.mtimeMs };
  },
  async readTextFrom(filePath: string, fromByteOffset: number): Promise<string> {
    const fileHandle = await open(filePath, 'r');
    try {
      const collectedChunks: Buffer[] = [];
      let readOffset = fromByteOffset;
      for (;;) {
        const chunkBuffer = Buffer.allocUnsafe(FILE_READ_CHUNK_BYTES);
        const readResult = await fileHandle.read(chunkBuffer, 0, FILE_READ_CHUNK_BYTES, readOffset);
        if (readResult.bytesRead === 0) {
          break;
        }
        collectedChunks.push(chunkBuffer.subarray(0, readResult.bytesRead));
        readOffset += readResult.bytesRead;
      }
      return Buffer.concat(collectedChunks).toString('utf8');
    } finally {
      await fileHandle.close();
    }
  },
};

// ── the row ──────────────────────────────────────────────────────────────────
export type CostSourceKind = 'session' | 'subagent' | 'workflow-subagent' | 'other';

export interface CostUsageRow {
  // `msg:<message.id>` when the record has one; `line:<path>@<byteOffset>` when it
  // does not. The byte-offset form is stable under append-only growth AND under a
  // resumed partial read (the offset is absolute either way), so re-ingesting an
  // undedupable row is still idempotent even though it can never be merged with
  // anything else (rule 3).
  rowKey: string;
  messageId: string | null;
  // TRUE means "this row could not be deduped by message.id" — it is real spend
  // and is kept, but it is never merged with another row. Rule 3: on the JSONL
  // path the survey found zero of these; the daemon's own event path had 16 of
  // 60, so the case is handled explicitly rather than assumed away.
  undedupable: boolean;

  timestamp: string;
  // Per MESSAGE, never per agent — 31 files mix models within one agent (rule 10).
  model: string;

  projectSlug: string;
  // The record's own `cwd`. Slugs are NOT projects (rule 7) — `-home-ticktockbent`
  // and VIMES scratchpad dirs all appear as top-level project dirs — so
  // classification runs against the real cwd, not the directory name.
  projectCwd: string | null;
  // FALSE = the outside-`projectRoots` bucket. Retained and labelled, never dropped.
  insideProjectRoots: boolean;

  sessionId: string | null;
  agentId: string | null;
  attributionAgent: string | null;
  attributionSkill: string | null;
  isSidechain: boolean | null;
  requestId: string | null;
  // The parent→child join key for the ~46% of agents where the directory does not
  // encode the edge. Preserved here; the TREE is step 3's job, not this unit's.
  toolUseResultAgentId: string | null;

  sourcePath: string;
  sourceKind: CostSourceKind;

  // ⚠ rule 8: absent is NOT 'standard'. These are price modifiers and defaulting
  // one silently misprices, so absent (and the explicit JSON `null` the CLI writes
  // on some records) is carried through as null and asserted, never `?? 'standard'`.
  speed: string | null;
  serviceTier: string | null;
  inferenceGeo: string | null;

  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  cacheCreation5mInputTokens: number;
  cacheCreation1hInputTokens: number;

  // Sum of the six token fields. Used ONLY to pick which progressive snapshot's
  // descriptive fields win a merge; never a spend figure.
  settledScore: number;
}

export interface CostCorpusFileProgress {
  path: string;
  // The stat taken BEFORE the read. If the file grew during the read,
  // consumedBytes > observedSizeBytes and the next scan re-checks it.
  observedSizeBytes: number;
  observedMtimeMs: number;
  // Byte offset of the end of the last COMPLETE line consumed.
  consumedBytes: number;
}

export interface CostCorpusScanStats {
  jsonlFilesFound: number;
  filesRead: number;
  filesSkippedUnchanged: number;
  linesRead: number;
  malformedLines: number;
  // Records whose `message.usage` carried at least one token field.
  usageRecords: number;
  // `<synthetic>` model records — excluded as UNPRICEABLE (rule 6). They carry
  // zero usage; they are never priced and the string is never treated as a model.
  syntheticRecordsExcluded: number;
  // Rule 3's explicit count.
  usageRecordsWithoutMessageId: number;
  rowsOutsideProjectRoots: number;
  // A trailing fragment left unconsumed because the file was mid-write.
  filesWithPartialTrailingLine: number;
}

export interface CostCorpusScanResult {
  // RAW rows, in stable (sorted-path, then line) order, NOT deduped. Call
  // dedupeUsageRowsGlobally, or hand them to SqliteCostStore, which applies the
  // same merge in SQL so dedupe also spans runs.
  rows: CostUsageRow[];
  fileProgress: CostCorpusFileProgress[];
  stats: CostCorpusScanStats;
}

export interface CostCorpusScanOptions {
  projectsRoot: string;
  // Absolute roots from DaemonConfig.projectRoots (VIMES_PROJECT_ROOTS, D21).
  projectRoots: readonly string[];
  fileSystem?: CorpusFileSystem;
  // Progress from a previous scan, keyed by absolute path. Unchanged files are
  // skipped; changed files resume from their consumed offset.
  previousProgress?: ReadonlyMap<string, CostCorpusFileProgress>;
}

// ── merge: ELEMENTWISE MAX, never first-wins, never sum ───────────────────────
//
// Rule 1, the load-bearing one. A repeated `message.id` is NOT a copy: the
// transcript writes one record per content block carrying a PARTIAL usage
// snapshot, then a final record with the settled figure
// (`output_tokens: [5, 5, 455]`). First-wins reads 5 where the truth is 455 —
// 2.23× low project-wide, 6.5× on subagents, up to 19× on one message. Summing
// is worse. Max per field is the only correct primitive, and unlike "prefer the
// record with populated `usage.iterations`" it does not depend on a field
// continuing to exist (rule 0.6).
//
// Descriptive fields (model, speed, attribution, …) follow the STRICTLY more
// settled snapshot, ties resolved to the incumbent — so a scan in sorted-path
// order is deterministic. SqliteCostStore repeats this rule in SQL.
export function mergeUsageRows(incumbent: CostUsageRow, candidate: CostUsageRow): CostUsageRow {
  const candidateIsMoreSettled = candidate.settledScore > incumbent.settledScore;
  const descriptiveSource = candidateIsMoreSettled ? candidate : incumbent;
  return {
    ...descriptiveSource,
    rowKey: incumbent.rowKey,
    messageId: incumbent.messageId,
    undedupable: incumbent.undedupable,
    inputTokens: Math.max(incumbent.inputTokens, candidate.inputTokens),
    outputTokens: Math.max(incumbent.outputTokens, candidate.outputTokens),
    cacheReadInputTokens: Math.max(incumbent.cacheReadInputTokens, candidate.cacheReadInputTokens),
    cacheCreationInputTokens: Math.max(
      incumbent.cacheCreationInputTokens,
      candidate.cacheCreationInputTokens,
    ),
    cacheCreation5mInputTokens: Math.max(
      incumbent.cacheCreation5mInputTokens,
      candidate.cacheCreation5mInputTokens,
    ),
    cacheCreation1hInputTokens: Math.max(
      incumbent.cacheCreation1hInputTokens,
      candidate.cacheCreation1hInputTokens,
    ),
    settledScore: Math.max(incumbent.settledScore, candidate.settledScore),
  };
}

// GLOBAL dedupe, not per-file. `message.id` is globally unique per real API
// response (zero cross-project collisions, zero parent↔subagent overlap), and
// `subagent_type: 'fork'` copies the spawner's rows while forked/compacted
// sessions copy the whole ancestor prefix — 394 ids appear in more than one
// session file, inflating a project rollup +6–13%. A row already seen ANYWHERE
// is the same spend, so per-file dedupe would bank that inflation (rule 5).
export function dedupeUsageRowsGlobally(rows: readonly CostUsageRow[]): CostUsageRow[] {
  const rowsByKey = new Map<string, CostUsageRow>();
  for (const row of rows) {
    const incumbent = rowsByKey.get(row.rowKey);
    rowsByKey.set(row.rowKey, incumbent === undefined ? row : mergeUsageRows(incumbent, row));
  }
  return [...rowsByKey.values()];
}

// ── record parsing ───────────────────────────────────────────────────────────
const SYNTHETIC_MODEL = '<synthetic>';

// Absent and explicit JSON null collapse to null — BOTH mean "not stated".
// Observed on `<synthetic>` records, which write `"speed": null` outright.
function readOptionalString(container: Record<string, unknown>, key: string): string | null {
  const value = container[key];
  return typeof value === 'string' ? value : null;
}

function readOptionalNumber(container: Record<string, unknown>, key: string): number {
  const value = container[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ParsedUsageRecord {
  row: CostUsageRow | null;
  hadUsage: boolean;
  wasSynthetic: boolean;
  missingMessageId: boolean;
}

interface RecordContext {
  sourcePath: string;
  sourceKind: CostSourceKind;
  projectSlug: string;
  lineByteOffset: number;
  projectRoots: readonly string[];
}

// True when `candidatePath` is `root` or sits underneath it. Prefix compare with
// a separator boundary so `/a/bc` never counts as inside `/a/b`.
export function isPathWithinRoots(candidatePath: string, roots: readonly string[]): boolean {
  for (const root of roots) {
    if (candidatePath === root || candidatePath.startsWith(root.endsWith(sep) ? root : root + sep)) {
      return true;
    }
  }
  return false;
}

function parseUsageRecord(record: unknown, context: RecordContext): ParsedUsageRecord {
  const empty: ParsedUsageRecord = {
    row: null,
    hadUsage: false,
    wasSynthetic: false,
    missingMessageId: false,
  };
  if (!isPlainObject(record)) {
    return empty;
  }
  const message = record.message;
  if (!isPlainObject(message)) {
    return empty;
  }
  const usage = message.usage;
  if (!isPlainObject(usage)) {
    return empty;
  }

  // ⚠ rule 4: `usage.iterations[]` is ALREADY rolled into the top-level fields.
  // It is deliberately not read here — summing it double-counts.
  const inputTokens = readOptionalNumber(usage, 'input_tokens');
  const outputTokens = readOptionalNumber(usage, 'output_tokens');
  const cacheReadInputTokens = readOptionalNumber(usage, 'cache_read_input_tokens');
  const cacheCreationInputTokens = readOptionalNumber(usage, 'cache_creation_input_tokens');
  const cacheCreationDetail = isPlainObject(usage.cache_creation) ? usage.cache_creation : {};
  const cacheCreation5mInputTokens = readOptionalNumber(
    cacheCreationDetail,
    'ephemeral_5m_input_tokens',
  );
  const cacheCreation1hInputTokens = readOptionalNumber(
    cacheCreationDetail,
    'ephemeral_1h_input_tokens',
  );

  const model = readOptionalString(message, 'model');
  if (model === SYNTHETIC_MODEL) {
    // Rule 6: excluded as UNPRICEABLE. These carry zero usage; they are never
    // priced and `<synthetic>` is never treated as a model name.
    return { row: null, hadUsage: true, wasSynthetic: true, missingMessageId: false };
  }

  const settledScore =
    inputTokens +
    outputTokens +
    cacheReadInputTokens +
    cacheCreationInputTokens +
    cacheCreation5mInputTokens +
    cacheCreation1hInputTokens;

  const messageId = readOptionalString(message, 'id');
  const timestamp = readOptionalString(record, 'timestamp');
  // Rule 9: timestamps are reliable (0 missing, 0 non-monotonic across 43,197
  // rows). A record without one is still real spend, so it is kept with an empty
  // timestamp rather than dropped — but it would be a rule-0.6 surprise worth
  // noticing, which is why it is not silently defaulted to "now".
  const projectCwd = readOptionalString(record, 'cwd');
  const toolUseResult = record.toolUseResult;
  const toolUseResultAgentId = isPlainObject(toolUseResult)
    ? readOptionalString(toolUseResult, 'agentId')
    : null;

  const row: CostUsageRow = {
    rowKey:
      messageId === null
        ? `line:${context.sourcePath}@${context.lineByteOffset}`
        : `msg:${messageId}`,
    messageId,
    undedupable: messageId === null,
    timestamp: timestamp ?? '',
    model: model ?? '',
    projectSlug: context.projectSlug,
    projectCwd,
    insideProjectRoots:
      projectCwd !== null && isPathWithinRoots(projectCwd, context.projectRoots),
    sessionId: readOptionalString(record, 'sessionId'),
    agentId: readOptionalString(record, 'agentId'),
    attributionAgent: readOptionalString(record, 'attributionAgent'),
    attributionSkill: readOptionalString(record, 'attributionSkill'),
    isSidechain: typeof record.isSidechain === 'boolean' ? record.isSidechain : null,
    requestId: readOptionalString(record, 'requestId'),
    toolUseResultAgentId,
    sourcePath: context.sourcePath,
    sourceKind: context.sourceKind,
    speed: readOptionalString(usage, 'speed'),
    serviceTier: readOptionalString(usage, 'service_tier'),
    inferenceGeo: readOptionalString(usage, 'inference_geo'),
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    cacheCreation5mInputTokens,
    cacheCreation1hInputTokens,
    settledScore,
  };
  return { row, hadUsage: true, wasSynthetic: false, missingMessageId: messageId === null };
}

// ── the walk ─────────────────────────────────────────────────────────────────
interface DiscoveredFile {
  path: string;
  projectSlug: string;
  sourceKind: CostSourceKind;
}

function classifySourceKind(relativeSegments: readonly string[]): CostSourceKind {
  // relativeSegments excludes the project slug and includes the file name.
  if (relativeSegments.length === 1) {
    return 'session';
  }
  if (relativeSegments.includes('subagents')) {
    return relativeSegments.includes('workflows') ? 'workflow-subagent' : 'subagent';
  }
  return 'other';
}

async function discoverJsonlFiles(
  fileSystem: CorpusFileSystem,
  directoryPath: string,
  projectSlug: string,
  relativeSegments: readonly string[],
  discovered: DiscoveredFile[],
): Promise<void> {
  let directoryEntries: CorpusDirectoryEntry[];
  try {
    directoryEntries = await fileSystem.listDirectory(directoryPath);
  } catch {
    return; // an unreadable directory is skipped, never fatal
  }
  // Sorted so the scan order — and therefore every merge tie-break — is stable.
  const sortedEntries = [...directoryEntries].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  for (const directoryEntry of sortedEntries) {
    const entryPath = join(directoryPath, directoryEntry.name);
    const entrySegments = [...relativeSegments, directoryEntry.name];
    if (directoryEntry.isDirectory) {
      // ⚠ rule 2: RECURSE. `subagents/` AND `subagents/workflows/wf_*/`. A
      // non-recursive glob misses the workflow tier entirely.
      await discoverJsonlFiles(fileSystem, entryPath, projectSlug, entrySegments, discovered);
      continue;
    }
    if (directoryEntry.isFile && directoryEntry.name.endsWith('.jsonl')) {
      discovered.push({
        path: entryPath,
        projectSlug,
        sourceKind: classifySourceKind(entrySegments),
      });
    }
  }
}

export async function scanCostCorpus(options: CostCorpusScanOptions): Promise<CostCorpusScanResult> {
  const fileSystem = options.fileSystem ?? nodeCorpusFileSystem;
  const previousProgress = options.previousProgress ?? new Map<string, CostCorpusFileProgress>();

  const discoveredFiles: DiscoveredFile[] = [];
  let projectDirectories: CorpusDirectoryEntry[] = [];
  try {
    projectDirectories = await fileSystem.listDirectory(options.projectsRoot);
  } catch {
    projectDirectories = [];
  }
  const sortedProjectDirectories = [...projectDirectories].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  for (const projectDirectory of sortedProjectDirectories) {
    if (!projectDirectory.isDirectory) {
      continue;
    }
    await discoverJsonlFiles(
      fileSystem,
      join(options.projectsRoot, projectDirectory.name),
      projectDirectory.name,
      [],
      discoveredFiles,
    );
  }

  const rows: CostUsageRow[] = [];
  const fileProgress: CostCorpusFileProgress[] = [];
  const stats: CostCorpusScanStats = {
    jsonlFilesFound: discoveredFiles.length,
    filesRead: 0,
    filesSkippedUnchanged: 0,
    linesRead: 0,
    malformedLines: 0,
    usageRecords: 0,
    syntheticRecordsExcluded: 0,
    usageRecordsWithoutMessageId: 0,
    rowsOutsideProjectRoots: 0,
    filesWithPartialTrailingLine: 0,
  };

  for (const discoveredFile of discoveredFiles) {
    let fileStats: CorpusFileStat;
    try {
      // Stat BEFORE the read: if the file grows underneath us, consumedBytes ends
      // up larger than this size, the unchanged-check fails next run, and the tail
      // is picked up then.
      fileStats = await fileSystem.statFile(discoveredFile.path);
    } catch {
      continue;
    }
    const previous = previousProgress.get(discoveredFile.path);
    if (
      previous !== undefined &&
      previous.observedSizeBytes === fileStats.sizeBytes &&
      previous.observedMtimeMs === fileStats.mtimeMs &&
      previous.consumedBytes === fileStats.sizeBytes
    ) {
      stats.filesSkippedUnchanged += 1;
      fileProgress.push(previous);
      continue;
    }
    // Resume from the previous offset unless the file shrank (truncated or
    // rewritten), in which case everything is re-read — max-wins dedupe makes
    // that safe.
    const startByteOffset =
      previous === undefined || previous.consumedBytes > fileStats.sizeBytes
        ? 0
        : previous.consumedBytes;

    let text: string;
    try {
      text = await fileSystem.readTextFrom(discoveredFile.path, startByteOffset);
    } catch {
      continue;
    }
    stats.filesRead += 1;

    // Only COMPLETE lines are consumed. A trailing fragment is a record being
    // written right now; it is neither parsed nor marked consumed, so the next
    // scan re-reads it whole.
    const lastNewlineIndex = text.lastIndexOf('\n');
    const completeText = lastNewlineIndex >= 0 ? text.slice(0, lastNewlineIndex + 1) : '';
    if (completeText.length < text.length) {
      stats.filesWithPartialTrailingLine += 1;
    }
    const consumedBytes = startByteOffset + Buffer.byteLength(completeText, 'utf8');

    // Undedupable rows are keyed by ABSOLUTE byte offset, so a full scan and a
    // resumed tail scan produce the same key for the same record.
    let lineByteOffset = startByteOffset;
    for (const rawLine of completeText.split('\n')) {
      const currentLineOffset = lineByteOffset;
      lineByteOffset += Buffer.byteLength(rawLine, 'utf8') + 1;
      if (rawLine.length === 0) {
        continue;
      }
      stats.linesRead += 1;
      let record: unknown;
      try {
        record = JSON.parse(rawLine);
      } catch {
        stats.malformedLines += 1;
        continue;
      }
      const parsed = parseUsageRecord(record, {
        sourcePath: discoveredFile.path,
        sourceKind: discoveredFile.sourceKind,
        projectSlug: discoveredFile.projectSlug,
        lineByteOffset: currentLineOffset,
        projectRoots: options.projectRoots,
      });
      if (parsed.hadUsage) {
        stats.usageRecords += 1;
      }
      if (parsed.wasSynthetic) {
        stats.syntheticRecordsExcluded += 1;
      }
      if (parsed.missingMessageId) {
        stats.usageRecordsWithoutMessageId += 1;
      }
      if (parsed.row !== null) {
        if (!parsed.row.insideProjectRoots) {
          stats.rowsOutsideProjectRoots += 1;
        }
        rows.push(parsed.row);
      }
    }

    fileProgress.push({
      path: discoveredFile.path,
      observedSizeBytes: fileStats.sizeBytes,
      observedMtimeMs: fileStats.mtimeMs,
      consumedBytes,
    });
  }

  return { rows, fileProgress, stats };
}
