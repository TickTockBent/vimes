import { TranscriptTail } from '../transcript/tail.js';
import { mapTranscriptOutputs } from '../transcript/mapper.js';
import { emitGuardedLiveness } from './liveness.js';
import type { FakeProcessTable, ProcessHandle } from './registry.js';
import type { World } from './world.js';

// A scripted PTY-hosted run. transcriptChunk feeds the per-session JSONL tail (the
// only parsed channel); bytes are the raw terminal channel — rule 0.8, NEVER
// parsed, only counted so artifacts prove the channel was exercised.
export type PtyFeedStep =
  | { kind: 'transcriptChunk'; chunk: string }
  | { kind: 'bytes'; bytes: string }
  | { kind: 'exit' };

const utf8Encoder = new TextEncoder();

export class FakePty implements FakeProcessTable {
  private readonly world: World;
  private readonly liveProcesses = new Map<string, ProcessHandle>();
  private readonly tailBySession = new Map<string, TranscriptTail>();
  private readonly rawByteCountByProcessId = new Map<string, number>();

  constructor(world: World) {
    this.world = world;
  }

  markLive(handle: ProcessHandle): void {
    this.liveProcesses.set(handle.processId, handle);
    if (!this.rawByteCountByProcessId.has(handle.processId)) {
      this.rawByteCountByProcessId.set(handle.processId, 0);
    }
  }

  markExited(processId: string): void {
    this.liveProcesses.delete(processId);
  }

  liveProcessIds(): string[] {
    return [...this.liveProcesses.keys()];
  }

  totalRawBytes(): number {
    let total = 0;
    for (const count of this.rawByteCountByProcessId.values()) {
      total += count;
    }
    return total;
  }

  private tailFor(appSessionId: string): TranscriptTail {
    let tail = this.tailBySession.get(appSessionId);
    if (tail === undefined) {
      tail = new TranscriptTail();
      this.tailBySession.set(appSessionId, tail);
    }
    return tail;
  }

  run(handle: ProcessHandle, feed: PtyFeedStep[]): void {
    const appSessionId = handle.appSessionId;
    // A deterministic synthetic path — a property of the file being tailed, not of
    // the tail's rotation output (which carries only the new sessionId).
    const jsonlPath = `/fake/${appSessionId}.jsonl`;
    for (const step of feed) {
      switch (step.kind) {
        case 'transcriptChunk': {
          const outputs = this.tailFor(appSessionId).push(step.chunk);
          const events = mapTranscriptOutputs(appSessionId, outputs, jsonlPath);
          if (events.length > 0) {
            this.world.router.emit(events);
          }
          break;
        }
        case 'bytes': {
          const priorCount = this.rawByteCountByProcessId.get(handle.processId) ?? 0;
          this.rawByteCountByProcessId.set(
            handle.processId,
            priorCount + utf8Encoder.encode(step.bytes).length,
          );
          break;
        }
        case 'exit':
          emitGuardedLiveness(this.world, appSessionId, 'dormant', 'pty-exit');
          this.world.registry.exitProcess(handle);
          break;
      }
    }
  }
}
