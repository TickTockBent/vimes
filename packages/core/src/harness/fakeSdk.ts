import {
  gateFired,
  message,
  questionAsked,
  runCompleted,
  usageBlock,
  withNotificationTrigger,
} from '../events.js';
import { emitGuardedLiveness } from './liveness.js';
import type { FakeProcessTable, ProcessHandle } from './registry.js';
import type { World } from './world.js';

// A scripted SDK-hosted run. Feed steps are typed TS data (never files): each
// step emits the matching vocabulary event through the router on the session's
// stream. gate/question/complete carry their notification_trigger (I5 batch).
export type SdkFeedStep =
  | { kind: 'message'; role: string; content: unknown }
  | { kind: 'usage'; usage: Record<string, unknown> }
  | { kind: 'gate'; prompt: string }
  | { kind: 'question'; prompt: string }
  | { kind: 'complete' };

export class FakeSdk implements FakeProcessTable {
  private readonly world: World;
  private readonly liveProcesses = new Map<string, ProcessHandle>();

  constructor(world: World) {
    this.world = world;
  }

  markLive(handle: ProcessHandle): void {
    this.liveProcesses.set(handle.processId, handle);
  }

  markExited(processId: string): void {
    this.liveProcesses.delete(processId);
  }

  liveProcessIds(): string[] {
    return [...this.liveProcesses.keys()];
  }

  run(handle: ProcessHandle, feed: SdkFeedStep[]): void {
    const appSessionId = handle.appSessionId;
    for (const step of feed) {
      switch (step.kind) {
        case 'message':
          this.world.router.emit([message({ appSessionId, role: step.role, content: step.content })]);
          break;
        case 'usage':
          this.world.router.emit([usageBlock({ appSessionId, usage: step.usage })]);
          break;
        case 'gate':
          this.world.router.emit(
            withNotificationTrigger(gateFired({ appSessionId, prompt: step.prompt })),
          );
          break;
        case 'question':
          this.world.router.emit(
            withNotificationTrigger(questionAsked({ appSessionId, prompt: step.prompt })),
          );
          break;
        case 'complete':
          // Attention 'completed' (+ trigger), then wind the process down.
          this.world.router.emit(withNotificationTrigger(runCompleted({ appSessionId })));
          emitGuardedLiveness(this.world, appSessionId, 'dormant', 'run-complete');
          this.world.registry.exitProcess(handle);
          break;
      }
    }
  }
}
