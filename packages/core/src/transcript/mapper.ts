import type { EventInput } from '../schemas.js';
import {
  claudeSessionMapped,
  lineQuarantined,
  message,
  usageBlock,
} from '../events.js';
import type { TailOutput } from './tail.js';

// Loose parse (rule 0.6): pull role/content/usage out of a transcript record
// without insisting on a full shape. Unknown fields are tolerated.
interface LooseTranscriptRecord {
  message?: { role?: unknown; content?: unknown; usage?: unknown };
}

// Map tail outputs to domain events for one app session. jsonlPath is supplied
// by the caller (the tail's rotation output carries only the new sessionId; the
// path is a property of the file being tailed).
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
        const messageBody = (json as LooseTranscriptRecord).message;
        if (messageBody === undefined || typeof messageBody.role !== 'string') {
          // Non-message records (mode, snapshots, alien shapes) carry no message
          // event.
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
