import type { EventInput } from '../schemas.js';
import {
  claudeSessionMapped,
  correctionDelivered,
  lineQuarantined,
  message,
  usageBlock,
} from '../events.js';
import type { TailOutput } from './tail.js';

// Loose parse (rule 0.6): pull role/content/usage out of a transcript record
// without insisting on a full shape. Unknown fields are tolerated.
interface LooseTranscriptRecord {
  type?: unknown;
  attachment?: unknown;
  message?: { role?: unknown; content?: unknown; usage?: unknown };
}

// ─── the `queued_command` attachment (slice 6 step 6a) ───────────────────────
//
// **THE DISCRIMINATOR IS `commandMode === 'prompt'`, AND NOTHING ELSE.**
//
// MEASURED 2026-07-22 over 30 real transcripts / 134 `queued_command`
// attachments in the live store — not inferred, and the measurement CORRECTED
// the earlier S1/D5 prose, which recorded `'prompt'` as though it were the only
// value it could take. It is not:
//
//     commandMode: 'prompt' ×72   |   'task-notification' ×62
//
// i.e. **~46% of these attachments are AGENT TASK-NOTIFICATIONS, not human
// steers.** A recognizer that treated every `queued_command` as a correction
// would false-positive on nearly half of them — and a false correction event
// makes the watchdog protect a run that nobody is steering, which is a run that
// can wedge silently forever with the guard switched off.
//
// ⚠ **`origin.kind === 'human'` IS EVIDENCE AND MUST NEVER BECOME A FILTER.**
// Cross-tabbed against the same corpus: `task-notification` carried no origin in
// 62/62, while `prompt` was `'human'` ×47 and **carried no origin at all ×25**.
// Requiring `origin.kind === 'human'` would therefore drop those 25 unmarked
// `prompt` records — and that unmarked population is precisely the one VIMES's
// OWN SDK injections most resemble. Requiring the field would silently discard
// our own corrections. It rides in the payload; it decides nothing.
//
// An unrecognized `commandMode` yields NO event — it is not a correction, and we
// do not guess. The observed mode is copied VERBATIM into the payload (never
// restated as the constant it matched), so widening the discriminator later
// needs no schema change to read the value back out of the log.
const CORRECTION_COMMAND_MODE = 'prompt';

// The (loose) attachment body. Every field is `unknown` because every field is
// external: this is a fragile-adapter boundary (rule 0.6), and a partial or
// alien attachment must be a NO-OP, never an exception (I8).
interface LooseQueuedCommandAttachment {
  type?: unknown;
  commandMode?: unknown;
  timestamp?: unknown;
  origin?: unknown;
}

function isObject(candidate: unknown): candidate is Record<string, unknown> {
  return candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate);
}

function optionalString(candidate: unknown): string | undefined {
  return typeof candidate === 'string' ? candidate : undefined;
}

// Recognize ONE record. Returns null for anything that is not a delivered
// correction — a different record type, a different attachment subtype, a
// task-notification, an unknown mode, or a malformed body.
function correctionDeliveredFromRecord(
  appSessionId: string,
  record: LooseTranscriptRecord,
): EventInput | null {
  if (record.type !== 'attachment' || !isObject(record.attachment)) {
    return null;
  }
  const attachment = record.attachment as LooseQueuedCommandAttachment;
  if (attachment.type !== 'queued_command') {
    return null;
  }
  if (attachment.commandMode !== CORRECTION_COMMAND_MODE) {
    // 'task-notification' (62/134 of the corpus) and any mode a future CLI
    // introduces both land here: not a correction, no event, no throw, no
    // quarantine.
    return null;
  }
  return correctionDelivered({
    appSessionId,
    // Verbatim off the record, not the constant. See CORRECTION_COMMAND_MODE.
    commandMode: attachment.commandMode,
    // Evidence only. Absent in 25 of 72 observed `prompt` records.
    originKind: isObject(attachment.origin) ? optionalString(attachment.origin.kind) : undefined,
    // The ENQUEUE time. Absent in ~20% of real records, so `undefined` here is
    // an ordinary observation and never an error.
    enqueuedAt: optionalString(attachment.timestamp),
  });
}

// Map tail outputs to domain events for one app session. jsonlPath is supplied
// by the caller (the tail's rotation output carries only the new sessionId; the
// path is a property of the file being tailed).
//
// ⚠ **NOTHING HERE SORTS, AND NOTHING HERE MAY EVER SORT — LEAST OF ALL BY
// `timestamp`** (this touches I6). Events are emitted strictly in the order the
// records were READ, because FILE POSITION IS THE DELIVERY TRUTH. The
// `queued_command` attachment is the case that proves it: it carries the ENQUEUE
// timestamp but sits at the DELIVERY file position, and the two were **30.4 s
// apart** in observed run A5. Worse, the attachment's position relative to the
// matching `queue-operation`/remove is **not stable between runs** (A1:
// attachment then remove; A5: remove then attachment). Ordering these records by
// their own `timestamp` would therefore reorder deliveries against the sequence
// the CLI actually performed them in — and a projection folded from a reordered
// log is a projection that disagrees with a replay of the same log.
export function mapTranscriptOutputs(
  appSessionId: string,
  outputs: TailOutput[],
  jsonlPath: string,
): EventInput[] {
  const events: EventInput[] = [];

  for (const output of outputs) {
    switch (output.kind) {
      case 'rotation':
        events.push(
          claudeSessionMapped({
            appSessionId,
            claudeSessionId: output.newClaudeSessionId,
            jsonlPath,
          }),
        );
        break;

      case 'quarantined':
        events.push(lineQuarantined({ appSessionId, raw: output.raw, reason: output.reason }));
        break;

      case 'record': {
        const json = output.json;
        if (json === null || typeof json !== 'object') {
          break;
        }
        const record = json as LooseTranscriptRecord;

        // ⚠ RECOGNIZED BEFORE THE `message.role` EARLY-OUT BELOW, deliberately.
        // A `queued_command` attachment has NO `message` field, so until this
        // line existed it fell into the "non-message record" break and was
        // dropped entirely — which is exactly why mid-run corrections were
        // INVISIBLE in the session stream (risk-register.md says so in as many
        // words). The recognizer sits here, in the ONE pure record-shape map, so
        // no other module ever learns this shape.
        const correctionEvent = correctionDeliveredFromRecord(appSessionId, record);
        if (correctionEvent !== null) {
          events.push(correctionEvent);
        }

        const messageBody = record.message;
        if (messageBody === undefined || typeof messageBody.role !== 'string') {
          // Non-message records (mode, snapshots, attachments, alien shapes)
          // carry no message event.
          break;
        }
        events.push(
          message({
            appSessionId,
            role: messageBody.role,
            content: messageBody.content ?? null,
          }),
        );
        // Assistant records carrying a usage object additionally emit usage_block.
        if (messageBody.usage !== null && typeof messageBody.usage === 'object') {
          events.push(
            usageBlock({ appSessionId, usage: messageBody.usage as Record<string, unknown> }),
          );
        }
        break;
      }
    }
  }

  return events;
}
