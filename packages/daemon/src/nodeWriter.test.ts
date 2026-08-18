import { describe, expect, it } from 'vitest';
import {
  CountingIdSource,
  EVENT_TYPES,
  MemoryEventStore,
  SteppingClock,
  nodesProjection,
  projectArchived,
  projectCreated,
  projectsProjection,
  readAllStreamsGrouped,
  replayFromEmpty,
  sessionsProjection,
  type EventRecord,
  type NodeProvenance,
} from '@vimes/core';
import {
  NodeWriter,
  checkoutNodeRefusalReasonSchema,
  type CheckoutNodeRefusalReason,
  type CreateCheckoutNodeInput,
} from './nodeWriter.js';

// ─── S17·U2 Part B — the ENGINE path, at the writer (slice-17.md §1) ─────────
//
// The rest of `NodeWriter` is exercised through the HTTP surface in
// nodeApi.test.ts, deliberately: that file's subject is what a REQUEST can do,
// and its exact-equality test over `nodeRefusalReasonSchema` is the pin that
// says the API's vocabulary has no dead members and no free text.
//
// `createCheckoutNode` is reachable through NO route, so it could not live
// there without weakening that pin. It gets its own file and its own closed
// enum — same reasoning, opposite audience.
//
// ⚠ THE INSTRUMENT IS THE EVENT, NOT THE RETURN VALUE. Two claims are only
// visible in the log: that a refusal writes NOTHING, and that the provenance
// which comes back was folded from a real `node_created` rather than echoed.

const PROJECT_ID = 'proj-alpha';
const PROJECT_ROOT = '/home/example/projects/alpha';
const NODE_ID = 'node-0001';

const PROVENANCE: NodeProvenance = {
  branch: 'vimes/node-node-0001',
  baseRef: 'main',
  resolvedCommit: 'c0ffee1234567890',
  path: '/var/lib/vimes-worktrees/node-node-0001',
};

interface WriterHarness {
  writer: NodeWriter;
  nodeEvents: () => EventRecord[];
  nodesHead: () => number;
  mintedIdCount: () => number;
  declareProject: (projectId: string, root: string) => void;
  archiveProject: (projectId: string) => void;
}

function buildWriterHarness(): WriterHarness {
  const store = new MemoryEventStore({
    clock: new SteppingClock('2026-08-18T12:00:00.000Z', 1000),
    ids: new CountingIdSource(),
  });

  const idSource = new CountingIdSource();
  let mintedIdCount = 0;
  const countingIds = {
    uuid: () => {
      mintedIdCount += 1;
      return idSource.uuid();
    },
  };

  const writer = new NodeWriter({
    emit: (events) => store.append(events),
    readProjects: () => replayFromEmpty(projectsProjection, readAllStreamsGrouped(store)),
    readNodes: () => replayFromEmpty(nodesProjection, readAllStreamsGrouped(store)),
    readSessions: () => replayFromEmpty(sessionsProjection, readAllStreamsGrouped(store)),
    ids: countingIds,
  });

  return {
    writer,
    nodeEvents: () => store.read('nodes', 1),
    nodesHead: () => store.head('nodes'),
    mintedIdCount: () => mintedIdCount,
    declareProject: (projectId, root) => {
      store.append([projectCreated({ projectId, root })]);
    },
    archiveProject: (projectId) => {
      store.append([projectArchived({ projectId })]);
    },
  };
}

function harnessWithProject(): WriterHarness {
  const harness = buildWriterHarness();
  harness.declareProject(PROJECT_ID, PROJECT_ROOT);
  return harness;
}

function checkoutInput(overrides: Partial<CreateCheckoutNodeInput> = {}): CreateCheckoutNodeInput {
  return {
    nodeId: NODE_ID,
    projectId: PROJECT_ID,
    name: PROVENANCE.branch,
    directory: PROVENANCE.path,
    provenance: PROVENANCE,
    ...overrides,
  };
}

describe('NodeWriter.createCheckoutNode — the seal opens exactly one crack', () => {
  it('records the provenance AS FOLDED, with the caller-supplied nodeId', () => {
    const harness = harnessWithProject();
    const result = harness.writer.createCheckoutNode(checkoutInput());

    expect(result.outcome).toBe('created');
    if (result.outcome !== 'created') {
      return;
    }
    // The record is the FOLD: `createdAt`, `closed` and `sessionIds` exist only
    // because the projection produced them.
    expect(result.node.nodeId).toBe(NODE_ID);
    expect(result.node.provenance).toEqual(PROVENANCE);
    expect(result.node.directory).toBe(PROVENANCE.path);
    expect(result.node.parentNodeId).toBeNull();
    expect(result.node.projectId).toBe(PROJECT_ID);
    expect(result.node.closed).toBe(false);
    expect(result.node.sessionIds).toEqual([]);
    // S14-F2: `createdAt` is the STORE's `ts` for the birth event — the second
    // tick of the stepping clock (the project's own birth took the first) — and
    // never a clock this writer reads.
    expect(result.node.createdAt).toBe('2026-08-18T12:00:01.000Z');

    // ONE event, and its payload carries the claim.
    const events = harness.nodeEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe(EVENT_TYPES.nodeCreated);
    expect((events[0]!.payload as { provenance: unknown }).provenance).toEqual(PROVENANCE);
    expect((events[0]!.payload as { nodeId: string }).nodeId).toBe(NODE_ID);
  });

  it('mints NOTHING from the injected id source — the id arrives already spent (§3.2)', () => {
    const harness = harnessWithProject();
    harness.writer.createCheckoutNode(checkoutInput());
    // The branch and path were derived from this id one layer up, BEFORE git
    // ran; a writer that minted its own would name a directory nobody created.
    expect(harness.mintedIdCount()).toBe(0);
  });

  it('S14-A2 stays intact: the PUBLIC create path still stamps provenance null', () => {
    const harness = harnessWithProject();
    const publicResult = harness.writer.createNode({
      projectId: PROJECT_ID,
      parentNodeId: null,
      name: 'a plain group',
      directory: null,
    });
    expect(publicResult.outcome).toBe('created');
    if (publicResult.outcome !== 'created') {
      return;
    }
    expect(publicResult.node.provenance).toBeNull();
    // …and the two paths coexist on one stream without either learning the
    // other's rules: the public one still mints its own id.
    expect(harness.mintedIdCount()).toBe(1);
  });

  it('A3 (writer half): a SECOND provenance write for the same node refuses LOUDLY and writes nothing', () => {
    const harness = harnessWithProject();
    expect(harness.writer.createCheckoutNode(checkoutInput()).outcome).toBe('created');
    const headAfterFirst = harness.nodesHead();

    const second = harness.writer.createCheckoutNode(
      checkoutInput({
        provenance: { ...PROVENANCE, branch: 'vimes/node-somewhere-else', resolvedCommit: 'deadbeef' },
      }),
    );
    expect(second).toEqual({ outcome: 'refused', reason: 'node-already-exists' });
    // ⚠ NOTHING WRITTEN. The fold's ignore-duplicate would have produced a
    // silent success here; the refusal is what makes the second claim visible.
    expect(harness.nodesHead()).toBe(headAfterFirst);
    expect(harness.nodeEvents()).toHaveLength(1);

    // And the FIRST claim is untouched — write-once means the original, not the
    // last writer.
    const firstBirth = harness.nodeEvents()[0]!.payload as { provenance: NodeProvenance };
    expect(firstBirth.provenance.branch).toBe(PROVENANCE.branch);
  });

  it('A3 (writer half): the refusal also covers a node born through the PUBLIC path', () => {
    const harness = harnessWithProject();
    const publicNode = harness.writer.createNode({
      projectId: PROJECT_ID,
      parentNodeId: null,
      name: 'a plain group',
      directory: null,
    });
    expect(publicNode.outcome).toBe('created');
    if (publicNode.outcome !== 'created') {
      return;
    }
    // A provenance-less node may not be UPGRADED into a checkout by writing a
    // second birth record over it — that is the same write-once rule from the
    // other side, and it is why `null` stays `null` forever.
    const upgrade = harness.writer.createCheckoutNode(checkoutInput({ nodeId: publicNode.node.nodeId }));
    expect(upgrade).toEqual({ outcome: 'refused', reason: 'node-already-exists' });
    expect(harness.nodeEvents()).toHaveLength(1);
  });

  it('refuses an unknown project, and an ARCHIVED one counts as unknown', () => {
    const unknown = buildWriterHarness();
    expect(unknown.writer.createCheckoutNode(checkoutInput())).toEqual({
      outcome: 'refused',
      reason: 'unknown-project',
    });
    expect(unknown.nodesHead()).toBe(0);

    const archived = harnessWithProject();
    archived.archiveProject(PROJECT_ID);
    expect(archived.writer.createCheckoutNode(checkoutInput())).toEqual({
      outcome: 'refused',
      reason: 'unknown-project',
    });
    expect(archived.nodesHead()).toBe(0);
  });

  it('refuses a whitespace-only name and an empty nodeId, writing nothing either way', () => {
    const harness = harnessWithProject();
    expect(harness.writer.createCheckoutNode(checkoutInput({ name: '   ' }))).toEqual({
      outcome: 'refused',
      reason: 'empty-name',
    });
    expect(harness.writer.createCheckoutNode(checkoutInput({ nodeId: '  ' }))).toEqual({
      outcome: 'refused',
      reason: 'empty-node-id',
    });
    expect(harness.nodesHead()).toBe(0);
  });

  it('trims the name before recording it, exactly as the public path does', () => {
    const harness = harnessWithProject();
    const result = harness.writer.createCheckoutNode(checkoutInput({ name: '  vimes/node-x  ' }));
    expect(result.outcome).toBe('created');
    if (result.outcome !== 'created') {
      return;
    }
    expect(result.node.name).toBe('vimes/node-x');
  });

  it('every member of the closed enum is reachable, and nothing outside it is produced', () => {
    const observedReasons = new Set<CheckoutNodeRefusalReason>();
    const collect = (result: { outcome: string; reason?: CheckoutNodeRefusalReason }): void => {
      if (result.outcome === 'refused' && result.reason !== undefined) {
        observedReasons.add(result.reason);
      }
    };

    collect(buildWriterHarness().writer.createCheckoutNode(checkoutInput()));

    const harness = harnessWithProject();
    collect(harness.writer.createCheckoutNode(checkoutInput({ nodeId: '' })));
    collect(harness.writer.createCheckoutNode(checkoutInput({ name: '\t' })));
    harness.writer.createCheckoutNode(checkoutInput());
    collect(harness.writer.createCheckoutNode(checkoutInput()));

    // EXACT EQUALITY, both directions — the same pin nodeApi.test.ts holds over
    // the API's own enum: no dead vocabulary, no free text.
    expect([...observedReasons].sort()).toEqual([...checkoutNodeRefusalReasonSchema.options].sort());
  });
});
