import { describe, expect, it } from 'vitest';
import {
  CountingIdSource,
  MemoryEventStore,
  SteppingClock,
  readAllStreamsGrouped,
  replayFromEmpty,
  tasksProjection,
  type EventInput,
} from '@vimes/core';
import {
  CREATE_TASK_UNKNOWN_PROJECT_REFUSAL,
  buildCreateTaskSpec,
  createTaskAcknowledgement,
  type CreateTaskToolDeps,
} from './createTaskTool.js';
import { TaskWriter, type CreateTaskInput } from './taskWriter.js';

// ─── S8·6 — the author grant's handler (D56's first verb) ────────────────────
//
// Everything here runs the SPEC's handler directly, with a fake `createTask` — no
// session, no SDK, no event store. That is the whole point of the SDK-agnostic
// spec shape: the tool's behaviour is decidable headlessly (rule 0.3), and the
// only thing the session host contributes is WHETHER the spec is offered (pinned
// separately, in sessionHost.test.ts's exposure matrix).
//
// "ZERO EVENTS" is asserted throughout as "the writer was never called" —
// `TaskWriter.createTask` is the only thing that can emit here, so a call count of
// zero IS an event count of zero.

const PROJECT_ROOT = '/home/wes/projects/vimes';

const VALID_PAYLOAD = {
  title: 'Wire the provenance chip',
  scope: 'Board cards mark orchestrator-authored tasks so the rewrite rate is legible.',
  explicitlyOut: ['Drive verbs', 'Anything in the dispatched exposure matrix'],
  acceptanceCriteria: [
    { text: 'A card whose createdBy is orchestrator renders the chip' },
    { text: 'A card whose createdBy is human renders nothing' },
  ],
  killCriterion: 'The chip cannot be derived without a second board authority.',
};

function makeSpec(overrides: { projectRoot?: string | undefined } = {}) {
  const created: CreateTaskInput[] = [];
  let mintCounter = 0;
  // The resolver is a THUNK on purpose: a case can move the root between building
  // the spec and calling the handler, which is what pins the call-time read.
  let currentRoot: string | undefined =
    'projectRoot' in overrides ? overrides.projectRoot : PROJECT_ROOT;
  const deps: CreateTaskToolDeps = {
    createTask: (input) => {
      created.push(input);
      mintCounter += 1;
      return { taskId: `task-${mintCounter}` };
    },
    resolveProjectRoot: () => currentRoot,
  };
  return {
    spec: buildCreateTaskSpec(deps),
    created,
    setProjectRoot: (root: string | undefined) => {
      currentRoot = root;
    },
  };
}

// The handler's return, narrowed for the assertions below.
async function call(
  spec: ReturnType<typeof buildCreateTaskSpec>,
  payload: unknown,
): Promise<{ ok: boolean; acknowledgement?: string }> {
  return spec.handler(payload);
}

describe('buildCreateTaskSpec — the spec the model sees (D65)', () => {
  const { spec } = makeSpec();

  it('is named create_task and mounts on the vimes_board server', () => {
    // Together these are the wire name: `mcp__vimes_board__create_task`, which the
    // founding briefing states verbatim. The two must move together.
    expect(spec.name).toBe('create_task');
    expect(spec.server).toBe('vimes_board');
  });

  it('advertises exactly the five authorable fields — and none of the forced ones', () => {
    expect(Object.keys(spec.inputSchema)).toEqual([
      'title',
      'scope',
      'explicitlyOut',
      'acceptanceCriteria',
      'killCriterion',
    ]);
    for (const forcedField of ['projectRoot', 'stage', 'isolation', 'gates', 'createdBy']) {
      expect(Object.keys(spec.inputSchema)).not.toContain(forcedField);
    }
  });

  it('describes what it does NOT do as plainly as what it does', () => {
    // The walk-2 defence: a model that is not told the door is closed will decide
    // for itself whether it is.
    expect(spec.description).toContain('BACKLOG');
    expect(spec.description).toContain('does not promote, dispatch, review or amend');
  });
});

describe('buildCreateTaskSpec — the happy path (the forced fields win)', () => {
  it('creates with the FORCED project, provenance, stage and isolation', async () => {
    const { spec, created } = makeSpec();
    const result = await call(spec, VALID_PAYLOAD);

    expect(result.ok).toBe(true);
    expect(created).toHaveLength(1);
    const input = created[0]!;
    // Not the model's to name — every one of these came from the daemon.
    expect(input.projectRoot).toBe(PROJECT_ROOT);
    expect(input.createdBy).toBe('orchestrator');
    expect(input.stage).toBe('backlog');
    // ⚠ READ FROM THE HUMAN DOOR (`createTaskBodySchema.isolation`'s default), not
    // invented: both doors must produce the same kind of record.
    expect(input.isolation).toBe('worktree');
  });

  it('passes gates ABSENT — promotion is the gate on authored work', async () => {
    const { spec, created } = makeSpec();
    await call(spec, VALID_PAYLOAD);
    // Absent, not `{}`: an authored task's birth record stays byte-identical to an
    // ungated hand-made one (I6).
    expect('gates' in created[0]!).toBe(false);
  });

  it('passes the authored fields through verbatim, criteria as TEXT ONLY', async () => {
    const { spec, created } = makeSpec();
    await call(spec, VALID_PAYLOAD);
    const input = created[0]!;
    expect(input.title).toBe(VALID_PAYLOAD.title);
    expect(input.scope).toBe(VALID_PAYLOAD.scope);
    expect(input.explicitlyOut).toEqual(VALID_PAYLOAD.explicitlyOut);
    expect(input.killCriterion).toBe(VALID_PAYLOAD.killCriterion);
    // No ids anywhere — the writer mints one per criterion from the injected id
    // source, and this handler never sees or invents one.
    expect(input.acceptanceCriteria).toEqual([
      { text: 'A card whose createdBy is orchestrator renders the chip' },
      { text: 'A card whose createdBy is human renders nothing' },
    ]);
    for (const criterion of input.acceptanceCriteria!) {
      expect('id' in criterion).toBe(false);
    }
  });

  it('omits explicitlyOut when the author named none — absent stays absent', async () => {
    const { spec, created } = makeSpec();
    const { explicitlyOut: _omitted, ...withoutExplicitlyOut } = VALID_PAYLOAD;
    const result = await call(spec, withoutExplicitlyOut);
    expect(result.ok).toBe(true);
    expect('explicitlyOut' in created[0]!).toBe(false);
  });

  it('acknowledges with the MINTED taskId and the promotion sentence (pinned)', async () => {
    const { spec } = makeSpec();
    const result = await call(spec, VALID_PAYLOAD);
    // ⚠ PINNED VERBATIM. The taskId is the model's only handle on what it just
    // created, and the second sentence is the boundary of the grant — the same one
    // the founding briefing's doctrine section closes on.
    expect(result.acknowledgement).toBe(
      "Work-order task-1 created in backlog. Promotion is Wes's call, made from the board.",
    );
    expect(createTaskAcknowledgement('task-1')).toBe(result.acknowledgement);
  });
});

describe('buildCreateTaskSpec — the hostile payloads (strict, and ZERO events)', () => {
  // ⚠ THE FORCED-FIELD TEST THE SLICE PLAN NAMES. A payload that tries to name
  // another project, another stage, or its own gates must not be half-honoured:
  // it is a validation ERROR that writes nothing and TELLS the model the parameter
  // does not exist (principle 13 — strict-reject over silent-strip).
  it.each([
    ['projectRoot', '/home/wes/projects/somebody-else'],
    ['stage', 'implementing'],
    ['isolation', 'shared-dir'],
    ['gates', {}],
    ['createdBy', 'human'],
  ])('REJECTS a payload naming %s, names it back, and writes NOTHING', async (field, value) => {
    const { spec, created } = makeSpec();
    const result = await call(spec, { ...VALID_PAYLOAD, [field]: value });
    expect(result.ok).toBe(false);
    expect(result.acknowledgement).toContain('No task was created');
    // The refusal NAMES the offending field — a bare "invalid payload" is the
    // answer that produces a retry storm.
    expect(result.acknowledgement).toContain(field);
    expect(created).toEqual([]);
  });

  it('REJECTS an alien key nobody has heard of, and writes NOTHING', async () => {
    const { spec, created } = makeSpec();
    const result = await call(spec, { ...VALID_PAYLOAD, priority: 'urgent' });
    expect(result.ok).toBe(false);
    expect(result.acknowledgement).toContain('priority');
    expect(created).toEqual([]);
  });

  it.each(['title', 'scope', 'killCriterion', 'acceptanceCriteria'])(
    'REJECTS a payload missing %s, and writes NOTHING',
    async (missingField) => {
      const { spec, created } = makeSpec();
      const payload: Record<string, unknown> = { ...VALID_PAYLOAD };
      delete payload[missingField];
      const result = await call(spec, payload);
      expect(result.ok).toBe(false);
      expect(result.acknowledgement).toContain(missingField);
      expect(created).toEqual([]);
    },
  );

  it('names the PATH of a nested failure, not just the field', async () => {
    const { spec, created } = makeSpec();
    const result = await call(spec, {
      ...VALID_PAYLOAD,
      acceptanceCriteria: [{ text: 'fine' }, { text: '' }],
    });
    expect(result.ok).toBe(false);
    // Index and key, so the model can find the one criterion it got wrong.
    expect(result.acknowledgement).toContain('acceptanceCriteria.1.text');
    expect(created).toEqual([]);
  });

  it('REJECTS a criterion that hand-types an id — ids are minted server-side', async () => {
    const { spec, created } = makeSpec();
    const result = await call(spec, {
      ...VALID_PAYLOAD,
      acceptanceCriteria: [{ id: 'crit-1', text: 'checkable' }],
    });
    expect(result.ok).toBe(false);
    expect(created).toEqual([]);
  });

  it('is TOTAL over degenerate input — no shape throws out of a tool call (I8)', async () => {
    const { spec, created } = makeSpec();
    for (const degenerate of [undefined, null, 'a string', 42, [], { title: 1 }]) {
      const result = await call(spec, degenerate);
      expect(result.ok).toBe(false);
      expect(typeof result.acknowledgement).toBe('string');
    }
    expect(created).toEqual([]);
  });
});

describe('buildCreateTaskSpec — the project binding (read at CALL time)', () => {
  it('refuses when the registry no longer knows the project, and writes NOTHING', async () => {
    const { spec, created } = makeSpec({ projectRoot: undefined });
    const result = await call(spec, VALID_PAYLOAD);
    expect(result.ok).toBe(false);
    expect(result.acknowledgement).toBe(CREATE_TASK_UNKNOWN_PROJECT_REFUSAL);
    // Refusing is the only honest answer: the tool's safety property is that the
    // task binds to the orchestrator's OWN project, and there is no fallback root
    // that keeps that true.
    expect(created).toEqual([]);
  });

  it('reads the root FRESH — a root edited after the spawn binds the new one', async () => {
    const { spec, created, setProjectRoot } = makeSpec();
    setProjectRoot('/home/wes/projects/vimes-moved');
    await call(spec, VALID_PAYLOAD);
    expect(created[0]!.projectRoot).toBe('/home/wes/projects/vimes-moved');
  });

  it('resolves the root only AFTER validation — a bad payload costs no registry read', async () => {
    // Order matters for one reason: the refusal a model gets should be about what
    // IT did wrong when it did something wrong, never a registry message that
    // sends it looking in the wrong place.
    const { spec } = makeSpec({ projectRoot: undefined });
    const result = await call(spec, { ...VALID_PAYLOAD, stage: 'implementing' });
    expect(result.acknowledgement).toContain('stage');
    expect(result.acknowledgement).not.toBe(CREATE_TASK_UNKNOWN_PROJECT_REFUSAL);
  });
});

// ─── the REAL writer, end to end (I6) ────────────────────────────────────────
//
// Every case above fakes `createTask` to watch what the handler asks for. This
// one wires the tool to the ACTUAL `TaskWriter` over a real event store, because
// two things can only be seen there: what the authored `task_created` payload
// LOOKS LIKE on the log, and that replaying that log folds the same record twice
// (I6 — the log is the source of record, not a cache of one).
describe('buildCreateTaskSpec — against the REAL TaskWriter (I6)', () => {
  function realHarness() {
    const store = new MemoryEventStore({
      clock: new SteppingClock('2026-08-04T12:00:00.000Z', 1000),
      ids: new CountingIdSource(),
    });
    const emitted: EventInput[] = [];
    const writer = new TaskWriter({
      emit: (events) => {
        emitted.push(...events);
        store.append(events);
      },
      readTasks: () => replayFromEmpty(tasksProjection, readAllStreamsGrouped(store)),
      // Counting, injected (rule 0.3): the taskId AND the criterion ids are
      // byte-identical run to run.
      ids: new CountingIdSource(),
    });
    const spec = buildCreateTaskSpec({
      createTask: (input) => writer.createTask(input),
      resolveProjectRoot: () => PROJECT_ROOT,
    });
    return {
      spec,
      emitted,
      currentTasks: () => replayFromEmpty(tasksProjection, readAllStreamsGrouped(store)),
    };
  }

  it('writes ONE task_created whose payload carries the forced fields and MINTED criterion ids', async () => {
    const { spec, emitted } = realHarness();
    const result = await spec.handler(VALID_PAYLOAD);
    expect(result.ok).toBe(true);

    expect(emitted.map((event) => event.type)).toEqual(['task_created']);
    const payload = emitted[0]!.payload as Record<string, unknown>;
    expect(payload.projectRoot).toBe(PROJECT_ROOT);
    expect(payload.createdBy).toBe('orchestrator');
    expect(payload.stage).toBe('backlog');
    expect(payload.isolation).toBe('worktree');
    // Ungated, and ABSENT rather than `{}` — the byte-identity rule the writer
    // follows for every unauthored key.
    expect('gates' in payload).toBe(false);
    // The ids exist, they came from the injected source, and the model never saw
    // them: `{ text }` in, `{ id, text }` on the log.
    expect(payload.acceptanceCriteria).toEqual([
      {
        id: '00000000-0000-4000-8000-000000000002',
        text: 'A card whose createdBy is orchestrator renders the chip',
      },
      {
        id: '00000000-0000-4000-8000-000000000003',
        text: 'A card whose createdBy is human renders nothing',
      },
    ]);
    // ids 2 and 3 because id 1 was the taskId: one source, minted in order.
    expect(payload.taskId).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('the acknowledgement names the id the LOG minted, not one the tool invented', async () => {
    const { spec, emitted } = realHarness();
    const result = await spec.handler(VALID_PAYLOAD);
    const mintedTaskId = (emitted[0]!.payload as { taskId: string }).taskId;
    expect(result.acknowledgement).toBe(createTaskAcknowledgement(mintedTaskId));
  });

  it('the folded record lands in BACKLOG, orchestrator-authored — and replays identically (I6)', async () => {
    const { spec, currentTasks } = realHarness();
    await spec.handler(VALID_PAYLOAD);

    const afterCreate = currentTasks();
    const bornTask = Object.values(afterCreate.tasks)[0]!;
    expect(bornTask.stage).toBe('backlog');
    expect(bornTask.createdBy).toBe('orchestrator');
    expect(bornTask.projectRoot).toBe(PROJECT_ROOT);
    expect(bornTask.title).toBe(VALID_PAYLOAD.title);
    expect(bornTask.scope).toBe(VALID_PAYLOAD.scope);
    expect(bornTask.explicitlyOut).toEqual(VALID_PAYLOAD.explicitlyOut);
    expect(bornTask.killCriterion).toBe(VALID_PAYLOAD.killCriterion);
    expect(bornTask.acceptanceCriteria?.map((criterion) => criterion.text)).toEqual([
      'A card whose createdBy is orchestrator renders the chip',
      'A card whose createdBy is human renders nothing',
    ]);
    // ⚠ I6: a SECOND replay of the same log folds the SAME record. Nothing in the
    // authored path re-mints on replay — the ids were written into the event.
    expect(currentTasks()).toEqual(afterCreate);
  });

  it('a rejected payload leaves the log EMPTY — zero events, not a rejection record', async () => {
    const { spec, emitted, currentTasks } = realHarness();
    const result = await spec.handler({ ...VALID_PAYLOAD, stage: 'implementing' });
    expect(result.ok).toBe(false);
    // Nothing at all. An in-run validation failure is not a fact about the board;
    // it is a conversation the model has with its own tool call.
    expect(emitted).toEqual([]);
    expect(Object.keys(currentTasks().tasks)).toEqual([]);
  });
});

// ─── I7, at COMPILE level ────────────────────────────────────────────────────
//
// The handler closure receives ONE capability — `createTask` — plus the registry
// read. It holds no `TaskWriter`, so `proposeTaskTransition` and `amendWorkOrder`
// are not merely unused here: they are UNREACHABLE, and the compiler is what says
// so. This block is the pin: adding a drive verb to `CreateTaskToolDeps` stops the
// build here rather than quietly widening what an orchestrator can do.
type UnexpectedCapability = Exclude<keyof CreateTaskToolDeps, 'createTask' | 'resolveProjectRoot'>;
const _noDriveVerbsOnTheAuthorGrant: UnexpectedCapability extends never ? true : false = true;

describe('buildCreateTaskSpec — I7 (the capability is create-only)', () => {
  it('exposes create and the registry read, and NOTHING that moves the board', () => {
    // The compile-level pin above is the real assertion; this case exists so the
    // invariant appears in the test report and a reader knows to look up.
    expect(_noDriveVerbsOnTheAuthorGrant).toBe(true);
  });
});
