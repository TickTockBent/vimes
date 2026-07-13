// JSONL transcript tail parser (core, pure — slice-0.md, I8). Chunk-fed,
// line-buffered: a partial trailing line is held until its newline arrives.
// NEVER throws on any input.

export type TailQuarantineReason = 'malformed-json' | 'oversize';

export type TailOutput =
  | { kind: 'record'; json: unknown }
  | { kind: 'quarantined'; raw: string; reason: TailQuarantineReason }
  | { kind: 'rotation'; newClaudeSessionId: string };

// ⟨tune 1 MB PREVIEW⟩ — a plain default; nothing in slice 0 asserts this value.
export const DEFAULT_MAX_LINE_BYTES = 1_048_576;

const textEncoder = new TextEncoder();

export class TranscriptTail {
  private readonly maxLineBytes: number;
  // Parts of the current unterminated line. Buffering parts (rather than
  // concatenating a growing string) keeps push() O(chunk): newline search runs
  // only over each incoming chunk, and the parts join exactly once per complete
  // line — so 7-byte chunks over a multi-MB line stay linear, not quadratic.
  private pendingLineParts: string[] = [];
  private lastSeenSessionId: string | null = null;

  constructor(maxLineBytes: number = DEFAULT_MAX_LINE_BYTES) {
    this.maxLineBytes = maxLineBytes;
  }

  push(chunk: string): TailOutput[] {
    const outputs: TailOutput[] = [];
    let remaining = chunk;

    let newlineIndex = remaining.indexOf('\n');
    while (newlineIndex !== -1) {
      this.pendingLineParts.push(remaining.slice(0, newlineIndex));
      const rawLine = this.pendingLineParts.join('');
      this.pendingLineParts = [];
      this.consumeCompleteLine(rawLine, outputs);
      remaining = remaining.slice(newlineIndex + 1);
      newlineIndex = remaining.indexOf('\n');
    }
    if (remaining.length > 0) {
      this.pendingLineParts.push(remaining);
    }

    return outputs;
  }

  private consumeCompleteLine(rawLineWithCarriage: string, outputs: TailOutput[]): void {
    // Tolerate CRLF transcripts; an empty line carries no record and is skipped
    // (never quarantined) so blank separators cannot inflate quarantine counts.
    const rawLine = rawLineWithCarriage.endsWith('\r')
      ? rawLineWithCarriage.slice(0, -1)
      : rawLineWithCarriage;
    if (rawLine.length === 0) {
      return;
    }

    // Oversize is decided by byte length before any parse attempt.
    if (textEncoder.encode(rawLine).length > this.maxLineBytes) {
      outputs.push({ kind: 'quarantined', raw: rawLine, reason: 'oversize' });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      outputs.push({ kind: 'quarantined', raw: rawLine, reason: 'malformed-json' });
      return;
    }

    // Rotation (I1): a parsed record whose string sessionId differs from the
    // last seen one. The first sessionId ever seen also emits rotation — the
    // consumer treats it as the initial mapping. Emitted before its record so
    // the mapping lands ahead of the message it belongs to.
    if (parsed !== null && typeof parsed === 'object') {
      const candidateSessionId = (parsed as { sessionId?: unknown }).sessionId;
      if (typeof candidateSessionId === 'string' && candidateSessionId !== this.lastSeenSessionId) {
        this.lastSeenSessionId = candidateSessionId;
        outputs.push({ kind: 'rotation', newClaudeSessionId: candidateSessionId });
      }
    }

    // Unknown record shapes pass through as records (loose by design, rule 0.6).
    outputs.push({ kind: 'record', json: parsed });
  }
}
