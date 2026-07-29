import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import {
  composeOrchestratorFounding,
  composeOrchestratorReorientation,
  summarizeBoardForOrchestrator,
  type ProjectRecord,
  type ProjectsState,
  type SessionRecord,
  type SessionsState,
  type TasksState,
} from '@vimes/core';
import type { SessionHost } from './sessionHost.js';

// ─── S8·3 — the standing orchestrator's ENSURE surface (D56) ─────────────────
//
// ⚠ **MAINTENANCE HERE IS LAZY, NOT EAGER — READ THIS BEFORE ADDING A BOOT
// HOOK.** D56 says the daemon MAINTAINS the orchestrator, and the obvious reading
// of that is "respawn every project's orchestrator at boot". This unit deliberately
// does NOT do that, and the difference is not laziness:
//
//   • An orchestrator nobody is talking to takes no turns. A process kept alive
//     across a restart for a project nobody has opened is a Claude process holding
//     a slot for nothing.
//   • The machinery to rebuild liveness on demand ALREADY EXISTS and is already
//     exercised: daemon death marks live sessions `interrupted` (D13's boot
//     recovery, beat 7), and this endpoint resumes on the next contact.
//   • So "maintained" means exactly three things, all of them here: the RECORD
//     knows which session is the orchestrator (`orchestratorForProjectId`, folded
//     from the birth event), the ensure path reconstructs liveness the moment
//     somebody asks for it, and a refounding after a transcript dies carries the
//     standing notes forward.
//
// Eager/always-on orchestrators arrive with the events-as-turns grant (D56's far
// seam — board events delivered to the orchestrator as turns), because THAT is the
// first thing that needs a process nobody is currently talking to. Not before.
//
// ⚠ **THE ENDPOINT IS ENSURE — get-or-create-or-resume, IDEMPOTENT.** D56's
// singleton-per-project invariant is enforced BY CONSTRUCTION rather than by a
// refusal event: two concurrent ensures cannot produce two orchestrators because
// the second one finds the first one's session. See the route below for why that
// holds without a D54-style in-flight lock.
//
// ⚠ NO TIMER, NO INTERVAL, NO SUBSCRIPTION, NO `Date.now()` in this file. Every
// route runs to completion inside the request that invoked it.

export interface OrchestratorApiDeps {
  // The registry — read FRESH per request, never a cached copy this file holds.
  readProjects: () => ProjectsState;
  // The sessions fold — where the orchestrator marking and its liveness live.
  readSessions: () => SessionsState;
  // The board, for the founding briefing's summary.
  readTasks: () => TasksState;
  // ⚠ THE SESSION HOST ITSELF, NOT A SECOND SESSION AUTHORITY. `resumeSession` is
  // the EXISTING resume op (the same one wsHub calls for a human's own resume,
  // D46 rider 2) — this unit builds no second resume path, and it deliberately
  // does not touch `sendMessage`'s auto-resume either. `sendMessage` is the
  // ordinary turn path the dispatcher also uses, so an orchestrator's briefing is
  // an ordinary `message(role:'user')` in the log like every other turn.
  sessionHost: Pick<SessionHost, 'spawnSession' | 'resumeSession' | 'sendMessage'>;
  // `<vimesHome>/orchestrator-notes` — composed at the daemon boundary from the
  // configured data dir (`~/.vimes` by default), so this file never derives a home
  // directory and a test can point it at a temp dir.
  standingNotesDir: string;
  // The fs seam (rule 0.3). Defaults to the real read; mirrors the injected
  // `realpath` probe the file/git/project APIs take.
  readStandingNotes?: StandingNotesReader;
}

// Reads the standing-notes file, or returns `undefined` when there is none.
export type StandingNotesReader = (notesPath: string) => string | undefined;

// ── the wire contract ────────────────────────────────────────────────────────

// How a briefing turn landed. Reported rather than swallowed: a founded session
// whose briefing never reached it is a live orchestrator that does not know who it
// is, and that must be visible to the caller (the same reason the dispatcher
// reports `instructionDelivery`).
export type OrchestratorBriefingDelivery =
  | { status: 'sent' }
  | { status: 'not-delivered'; reason: string };

export type EnsureOrchestratorResponse =
  // A live orchestrator already exists — NO message is sent. Ensure is
  // get-or-create-or-resume, and "get" must not cost the running conversation a
  // turn it did not ask for.
  | { outcome: 'already-live'; appSessionId: string }
  // A dormant/interrupted transcript was resumed through the existing resume op.
  // The reorientation turn rides only after an INTERRUPTED one; see the handler.
  | { outcome: 'resumed'; appSessionId: string; briefingDelivery?: OrchestratorBriefingDelivery }
  // A new transcript was founded. `refounded` marks D56's rotation — this project
  // HAD an orchestrator and its transcript is dead, so a successor now carries the
  // standing notes forward.
  | {
      outcome: 'founded';
      appSessionId: string;
      refounded?: true;
      briefingDelivery: OrchestratorBriefingDelivery;
    }
  // The host refused the spawn (preflight, typically). Carried verbatim.
  | { outcome: 'spawn-refused'; reason: string }
  // The host refused the resume. The sibling of `spawn-refused`, and reported for
  // the same reason: the caller asked for a live orchestrator and did not get one.
  | { outcome: 'resume-refused'; reason: string };

export function registerOrchestratorApi(app: Hono, deps: OrchestratorApiDeps): void {
  const readStandingNotes = deps.readStandingNotes ?? readStandingNotesFile;

  // ── POST /api/projects/:projectId/orchestrator — ensure it exists and is live ─
  //
  // ⚠ **THIS HANDLER IS SYNCHRONOUS, AND THAT IS THE SINGLETON GUARANTEE.** It is
  // not `async`, reads no body, and awaits nothing: the projection reads, the
  // notes read, `spawnSession` and `sendMessage` are all synchronous, so from the
  // "is there already an orchestrator?" question to the spawn that answers it,
  // NOTHING YIELDS THE EVENT LOOP. A second ensure arriving in that window cannot
  // interleave — it runs after the first has already emitted `session_created`,
  // and therefore finds the session rather than founding a rival.
  //
  // That is precisely the property D54's per-task dispatch lock had to add
  // machinery for and this path gets for free: D54's exposure came from an
  // `await` (worktree creation, a subprocess) sitting between the decision and the
  // event that makes the decision visible. **If you ever add an `await` between
  // the lookup below and the spawn, you have reopened D54 territory here** and
  // this comment is the notice that a lock is then required.
  //
  //   • **404** — no such project. Nothing is spawned, nothing is written.
  //   • **409 `archived-project`** — the boundary has been retired; founding a
  //     standing entity for it would be reviving something a human put away.
  //   • **200 + the envelope** for every other outcome, refusals included — the
  //     `POST /api/tasks/:taskId/dispatch` convention verbatim: the caller gets
  //     "here is what happened", never a 4xx that invites retry machinery.
  app.post('/api/projects/:projectId/orchestrator', (context) => {
    const projectId = context.req.param('projectId');
    // ⚠ THE REGISTRY LOOKUP COMES FIRST, and it is also the path guard: the
    // projectId reaches `standingNotesPathFor` only after it has been matched
    // against a declared record, so a traversal-shaped param 404s here rather
    // than composing a filename out of hostile input.
    const project = deps.readProjects().projects[projectId];
    if (project === undefined) {
      return context.json({ error: 'not found' }, 404);
    }
    if (project.archived) {
      return context.json({ error: 'conflict', detail: 'archived-project' }, 409);
    }

    const orchestratorSessions = orchestratorSessionsFor(deps.readSessions(), projectId);
    // NEWEST FIRST, and only a transcript that is not dead can be adopted. A dead
    // record is history: D56's rotation replaces a transcript rather than reviving
    // it, and the dead predecessor's own record keeps its marking so the rotation
    // stays legible in the log.
    const standingSession = orchestratorSessions.find((session) => session.liveness !== 'dead');

    if (standingSession !== undefined) {
      if (standingSession.liveness === 'running' || standingSession.liveness === 'spawning') {
        // Already live. No turn is sent — see `already-live` on the response type.
        const response: EnsureOrchestratorResponse = {
          outcome: 'already-live',
          appSessionId: standingSession.appSessionId,
        };
        return context.json(response, 200);
      }

      // dormant | interrupted → the EXISTING resume op. Resume reads the RECORDED
      // cwd and the last mapped Claude session id (I3), which is what makes SP8·2's
      // hard requirement hold across a restart without this file re-deriving
      // anything: the cwd that was persisted at founding is the cwd `--resume` is
      // given, verbatim, and a wrong one fails outright with no fallback.
      const priorLiveness = standingSession.liveness;
      const resumeResult = deps.sessionHost.resumeSession(standingSession.appSessionId);
      if ('refused' in resumeResult) {
        const response: EnsureOrchestratorResponse = {
          outcome: 'resume-refused',
          reason: resumeResult.reason,
        };
        return context.json(response, 200);
      }

      // ⚠ **THE REORIENTATION TURN IS FOR `interrupted` ONLY**, and the asymmetry
      // is the whole content of SP8·2's third consequence. An INTERRUPTED session
      // is one the daemon's death cut off mid-life (D13's boot recovery marks it),
      // so "a restart happened, check what was in flight" is news. A DORMANT one
      // ended its turn cleanly and was simply not running — it has no restart story
      // to tell, and a turn saying otherwise would be VIMES inventing an event.
      const briefingDelivery =
        priorLiveness === 'interrupted'
          ? deliverTurn(
              deps.sessionHost,
              resumeResult.appSessionId,
              composeOrchestratorReorientation({
                projectName: orchestratorDisplayName(project),
                notesPath: standingNotesPathFor(deps.standingNotesDir, projectId),
              }),
            )
          : undefined;
      const response: EnsureOrchestratorResponse = {
        outcome: 'resumed',
        appSessionId: resumeResult.appSessionId,
        // Absent stays absent: a dormant resume's envelope carries no delivery key
        // at all, rather than a null that would read as "we tried and failed".
        ...(briefingDelivery === undefined ? {} : { briefingDelivery }),
      };
      return context.json(response, 200);
    }

    // ── FOUND (or REFOUND) ───────────────────────────────────────────────────
    //
    // Nothing live, nothing resumable: this project either never had an
    // orchestrator or its every transcript is dead. Either way a new one opens
    // with the whole of the entity's durable identity — the board plus whatever
    // the last one banked in its notes (D56: continuity is a property of the
    // ENTITY, not of any one process).
    const refounded = orchestratorSessions.length > 0;
    const notesPath = standingNotesPathFor(deps.standingNotesDir, projectId);
    const standingNotes = readStandingNotes(notesPath);
    const board = summarizeBoardForOrchestrator(
      Object.values(deps.readTasks().tasks),
      project.root,
    );

    const spawnResult = deps.sessionHost.spawnSession({
      // The SDK channel, like every other VIMES-driven session.
      channel: 'sdk',
      // ⚠ **`project.root` VERBATIM, STRAIGHT OFF THE RECORD — NEVER RE-DERIVED
      // AND NEVER `realpath`'d HERE.** SP8·2 observed that `claude --resume`
      // requires an EXACT cwd match: resuming from a sibling directory is a hard
      // failure (exit 1, "No conversation found"), with no fallback, no partial
      // recovery and no flag to point it elsewhere. The root was canonicalized
      // ONCE, at declaration time (projectApi.ts's `resolveWithinRoots`), so
      // re-resolving it here could only introduce a difference — and the day it
      // did, every resume of this orchestrator would fail forever.
      cwd: project.root,
      name: `Orchestrator — ${orchestratorDisplayName(project)}`,
      // D56's marking: presence IS the kind, and this is the only writer of it.
      orchestratorForProjectId: projectId,
      // ⚠ NO `permissionMode`, NO `dispatched`, NO `stage` — deliberately. The
      // orchestrator is an INTERACTIVE session (D56: a conversation partner, not
      // an unattended run), so it takes the SDK default footing, keeps the human
      // gate, and is offered none of the dispatched report tools. D58 (which
      // permission mode a tool-bearing orchestrator runs in) settles at S8·6,
      // with the author grant that first gives it a tool.
    });
    if ('refused' in spawnResult) {
      // No session exists, so there is nothing to brief and nothing to mark. The
      // host already evented its own refusal; reporting it again as an event here
      // would double-count one failure as two facts (the dispatcher's rationale).
      const response: EnsureOrchestratorResponse = {
        outcome: 'spawn-refused',
        reason: spawnResult.reason,
      };
      return context.json(response, 200);
    }

    // ONE turn after the session exists — the dispatcher's precedent exactly
    // (spawn, then a single `sendMessage`). Not a stream of setup messages: the
    // founding briefing is one message because the transcript should open the way
    // a conversation does.
    const briefingDelivery = deliverTurn(
      deps.sessionHost,
      spawnResult.appSessionId,
      composeOrchestratorFounding({
        projectName: orchestratorDisplayName(project),
        projectRoot: project.root,
        notesPath,
        // Absent stays absent all the way into the composer, which OMITS the
        // notes section entirely rather than rendering an empty heading.
        ...(standingNotes === undefined ? {} : { standingNotes }),
        board,
      }),
    );
    const response: EnsureOrchestratorResponse = {
      outcome: 'founded',
      appSessionId: spawnResult.appSessionId,
      // Spread rather than set: a FIRST founding's envelope carries no `refounded`
      // key at all. Present-and-true is the rotation observable.
      ...(refounded ? { refounded: true as const } : {}),
      briefingDelivery,
    };
    return context.json(response, 200);
  });
}

// ── internals ────────────────────────────────────────────────────────────────

// Every session ever marked as this project's orchestrator, NEWEST FIRST.
//
// Ordered by `createdAt` (the birth event's own `ts`, never a clock read here),
// with the appSessionId as the tie-break so two sessions born in the same
// millisecond still order deterministically — `Object.values` order is insertion
// order, which is neither meaningful nor stable across a snapshot boundary.
function orchestratorSessionsFor(sessions: SessionsState, projectId: string): SessionRecord[] {
  return Object.values(sessions.sessions)
    .filter((session) => session.orchestratorForProjectId === projectId)
    .sort((left, right) => {
      const byCreatedAt = right.createdAt.localeCompare(left.createdAt);
      return byCreatedAt !== 0 ? byCreatedAt : right.appSessionId.localeCompare(left.appSessionId);
    });
}

// `<vimesHome>/orchestrator-notes/<projectId>.md`.
//
// Keyed on the projectId rather than on the root's basename or its path segment:
// the id is stable for the life of the project, while a name can be patched and a
// path segment moves with the fence. Re-declaring an archived root mints a NEW id
// (ProjectWriter), so the new project correctly starts with no notes rather than
// inheriting its predecessor's.
export function standingNotesPathFor(standingNotesDir: string, projectId: string): string {
  return join(standingNotesDir, `${projectId}.md`);
}

// The real read (the fs boundary this module injects around, rule 0.3).
//
// ⚠ EVERY failure degrades to ABSENT, not to an error. ENOENT is the ORDINARY
// case — a first founding, before the orchestrator has ever banked anything — and
// the others (a directory where the file should be, a permission problem) are
// worth no more than a founding without the notes section: an orchestrator with no
// notes is exactly what this project has if the file cannot be read, and refusing
// to found one over it would leave the project with no orchestrator at all.
function readStandingNotesFile(notesPath: string): string | undefined {
  try {
    return readFileSync(notesPath, 'utf8');
  } catch {
    return undefined;
  }
}

// D42's name fallback — "absent a name, the directory basename is the name" —
// applied to the orchestrator's session name and to the project as the briefing
// names it.
//
// ⚠ A MIRROR of `projectDisplayName` in packages/ui/src/lib/projectContext.ts,
// deliberately, and the two must move in lockstep: the UI cannot import daemon
// code and this cannot import UI code. Both spell the same D42 read-time
// derivation, and NEITHER may store it — the record carries no name key when none
// was given, precisely so "unnamed" and "named after its folder" stay
// distinguishable in the log while reading identically on screen.
function orchestratorDisplayName(project: ProjectRecord): string {
  const declaredName = project.name?.trim() ?? '';
  if (declaredName !== '') {
    return declaredName;
  }
  const trimmedRoot = project.root.replace(/\/+$/, '');
  const basename = trimmedRoot.slice(trimmedRoot.lastIndexOf('/') + 1);
  // Never blank — the last resort is the root itself.
  return basename === '' ? project.root : basename;
}

// One turn, through the host's ordinary message path. TOTAL: the host's contract
// is to refuse rather than throw, but a route must survive its collaborators.
function deliverTurn(
  sessionHost: OrchestratorApiDeps['sessionHost'],
  appSessionId: string,
  text: string,
): OrchestratorBriefingDelivery {
  let sendResult;
  try {
    sendResult = sessionHost.sendMessage(appSessionId, text);
  } catch (sendError) {
    return {
      status: 'not-delivered',
      reason: `send-threw:${sendError instanceof Error ? sendError.message : String(sendError)}`,
    };
  }
  return 'refused' in sendResult
    ? { status: 'not-delivered', reason: sendResult.reason }
    : { status: 'sent' };
}
