import { sessionCreated, transitionRejected } from '../events.js';
import { emitGuardedLiveness } from './liveness.js';
import type { World } from './world.js';

// A fake process the harness owns. processId is a registry-internal counter value
// (deterministic, harness-only, never serialized into the log), so eventIds stay
// contiguous regardless of how many processes spawn.
export interface ProcessHandle {
  processId: string;
  kind: 'sdk' | 'pty';
  appSessionId: string;
}

// Minimal surface the registry needs from an adapter's fake process table.
export interface FakeProcessTable {
  markLive(handle: ProcessHandle): void;
  markExited(processId: string): void;
  liveProcessIds(): string[];
}

export interface ResumeRefused {
  refused: true;
  reason: string;
}
export interface ResumeSpawned {
  refused: false;
  handle: ProcessHandle;
}
export type ResumeResult = ResumeRefused | ResumeSpawned;

// The run registry and fake-process ownership (I4). Every live fake process has
// exactly one owner here; orphanScan proves the adapter tables never hold a
// process the registry does not own.
export class RunRegistry {
  private readonly world: World;
  private readonly ownedByProcessId = new Map<string, ProcessHandle>();
  private nextProcessCounter = 1;

  constructor(world: World) {
    this.world = world;
  }

  private tableFor(kind: 'sdk' | 'pty'): FakeProcessTable {
    return kind === 'sdk' ? this.world.fakeSdk : this.world.fakePty;
  }

  private hasLiveProcess(appSessionId: string): boolean {
    for (const handle of this.ownedByProcessId.values()) {
      if (handle.appSessionId === appSessionId) {
        return true;
      }
    }
    return false;
  }

  // Mint a new appSessionId and emit session_created (liveness born 'spawning').
  // The projection host must learn the stream before the event so it folds live.
  createSession(options: {
    channel: 'sdk' | 'pty';
    cwd: string;
    name?: string | null;
  }): string {
    const appSessionId = this.world.ids.uuid();
    this.world.projectionHost.ensureStream(appSessionId);
    this.world.router.emit([
      sessionCreated({
        appSessionId,
        channel: options.channel,
        cwd: options.cwd,
        name: options.name ?? null,
        forkedFrom: null,
        taskRef: null,
      }),
    ]);
    return appSessionId;
  }

  // Register a fresh fake process and drive the session 'spawning' -> 'running'.
  spawn(kind: 'sdk' | 'pty', appSessionId: string): ProcessHandle {
    const processId = `${kind}-proc-${this.nextProcessCounter}`;
    this.nextProcessCounter += 1;
    const handle: ProcessHandle = { processId, kind, appSessionId };
    this.tableFor(kind).markLive(handle);
    this.ownedByProcessId.set(processId, handle);
    emitGuardedLiveness(this.world, appSessionId, 'running', 'spawn');
    return handle;
  }

  // Drop ownership and mark the fake process exited in its adapter table. Liveness
  // is emitted by the caller (adapter complete/exit) — this is bookkeeping only.
  exitProcess(handle: ProcessHandle): void {
    this.ownedByProcessId.delete(handle.processId);
    this.tableFor(handle.kind).markExited(handle.processId);
  }

  listOwned(): ProcessHandle[] {
    return [...this.ownedByProcessId.values()];
  }

  // I11 shape (harness level; real-transcript assertion lands slice 1): a resume
  // against a session that already has a live process is refused before any
  // process spawns, and the refusal is evented as transition_rejected.
  resumeSession(appSessionId: string): ResumeResult {
    if (this.hasLiveProcess(appSessionId)) {
      const from =
        this.world.projectionHost.sessionsState().sessions[appSessionId]?.liveness ?? 'running';
      this.world.router.emit([
        transitionRejected({
          appSessionId,
          from,
          to: 'spawning',
          cause: 'concurrent-resume-refused',
        }),
      ]);
      return { refused: true, reason: 'session already has a live process' };
    }
    const session = this.world.projectionHost.sessionsState().sessions[appSessionId];
    const channel = session?.channel ?? 'sdk';
    // dormant|interrupted -> spawning -> running, both via the machine.
    emitGuardedLiveness(this.world, appSessionId, 'spawning', 'resume');
    const handle = this.spawn(channel, appSessionId);
    return { refused: false, handle };
  }

  // I3 shape: fork mints a NEW appSessionId with forkedFrom set; the source
  // session is untouched (no process moves, no liveness change on it).
  forkSession(fromAppSessionId: string): string {
    const source = this.world.projectionHost.sessionsState().sessions[fromAppSessionId];
    const newAppSessionId = this.world.ids.uuid();
    this.world.projectionHost.ensureStream(newAppSessionId);
    this.world.router.emit([
      sessionCreated({
        appSessionId: newAppSessionId,
        channel: source?.channel ?? 'sdk',
        cwd: source?.cwd ?? '/',
        name: source?.name ?? null,
        forkedFrom: fromAppSessionId,
        taskRef: null,
      }),
    ]);
    return newAppSessionId;
  }
}

// I4: fake processes alive in adapter tables but not owned by the registry. Must
// always be empty in a well-formed world.
export function orphanScan(world: World): string[] {
  const ownedProcessIds = new Set(world.registry.listOwned().map((handle) => handle.processId));
  const liveProcessIds = [...world.fakeSdk.liveProcessIds(), ...world.fakePty.liveProcessIds()];
  return liveProcessIds.filter((processId) => !ownedProcessIds.has(processId)).sort();
}

// The post-restart scan: any session the log last left 'running' or 'spawning'
// but which has no live process becomes 'interrupted', via the machine. Attention
// state is untouched (only liveness_changed is emitted). NOTE: the D9 edge set has
// no spawning->interrupted edge, so a 'spawning' session would surface a
// transition_rejected here instead — see the step-4 report (the cold-restart
// profile only leaves sessions 'running', so that branch is not exercised).
export function recoveryRoutine(world: World): void {
  const ownedAppSessionIds = new Set(
    world.registry.listOwned().map((handle) => handle.appSessionId),
  );
  const sessions = world.projectionHost.sessionsState().sessions;
  for (const appSessionId of Object.keys(sessions).sort()) {
    const liveness = sessions[appSessionId]!.liveness;
    if ((liveness === 'running' || liveness === 'spawning') && !ownedAppSessionIds.has(appSessionId)) {
      emitGuardedLiveness(world, appSessionId, 'interrupted', 'recovery-no-process');
    }
  }
}
