import { EVENT_TYPES } from '../../events.js';
import { readAllStreamsGrouped } from '../../projections/projection.js';
import { sessionsProjection } from '../../projections/sessions.js';
import { replayFromEmpty } from '../../projections/projection.js';
import type { PtyFeedStep } from '../fakePty.js';
import type { ScenarioProfile } from '../scenario.js';

// hostile-input (spec §7.5, I8): a PTY session fed hostile transcript content
// constructed in TS (core cannot read files). Nothing throws; malformed lines are
// quarantined with events; the tail resumes; the absurd count passes as data.
// (Upload path-traversal + auth probes join this profile in slice 1, I14.)
const CLAUDE_SESSION_ID = '33333333-3333-4333-8333-333333333333';

function jsonLine(record: unknown): string {
  return JSON.stringify(record);
}

// Just over the 1 MB tail limit, built by string repeat — deterministic.
const OVERSIZE_CONTENT = 'x'.repeat(1_050_000);

const HOSTILE_LINES: string[] = [
  jsonLine({ sessionId: CLAUDE_SESSION_ID, message: { role: 'user', content: 'start' } }),
  jsonLine({
    sessionId: CLAUDE_SESSION_ID,
    message: { role: 'assistant', content: 'working', usage: { input_tokens: 5, output_tokens: 7 } },
  }),
  '{"broken": ', // truncated JSON -> malformed-json quarantine
  'not json at all @#$%', // garbage -> malformed-json quarantine
  jsonLine({ sessionId: CLAUDE_SESSION_ID, type: 'summary', note: 'alien shape, no message field' }),
  jsonLine({
    sessionId: CLAUDE_SESSION_ID,
    // Absurd token count passes straight through as data — nothing validates it.
    message: { role: 'assistant', content: 'huge', usage: { output_tokens: 9e15 } },
  }),
  jsonLine({ sessionId: CLAUDE_SESSION_ID, message: { role: 'assistant', content: OVERSIZE_CONTENT } }),
  jsonLine({ sessionId: CLAUDE_SESSION_ID, message: { role: 'user', content: 'still there?' } }),
  jsonLine({ sessionId: CLAUDE_SESSION_ID, message: { role: 'assistant', content: 'yes, resumed' } }),
];

const HOSTILE_FEED: PtyFeedStep[] = [
  { kind: 'bytes', bytes: '[2J[H raw terminal paint ' },
  { kind: 'transcriptChunk', chunk: HOSTILE_LINES.join('\n') + '\n' },
  { kind: 'bytes', bytes: '[0m more raw bytes never parsed ' },
];

export const hostileInput: ScenarioProfile = {
  name: 'hostile-input',
  run(world) {
    const appSessionId = world.registry.createSession({ channel: 'pty', cwd: '/home/wes/hostile' });
    const handle = world.registry.spawn('pty', appSessionId);

    world.fakePty.run(handle, HOSTILE_FEED);

    // Unknown event types injected straight into the router are no-ops in every
    // projection (loose by design, rule 0.6).
    const sessionsBeforeUnknown = sessionsProjection.serialize(
      world.projectionHost.sessionsState(),
    );
    world.router.emit([{ stream: appSessionId, type: 'totally_unknown_type', payload: { appSessionId } }]);
    const sessionsAfterUnknown = sessionsProjection.serialize(
      world.projectionHost.sessionsState(),
    );
    if (sessionsBeforeUnknown !== sessionsAfterUnknown) {
      throw new Error('hostile-input: an unknown event type mutated a projection');
    }

    const grouped = readAllStreamsGrouped(world.store);
    const countOf = (type: string): number => grouped.filter((record) => record.type === type).length;

    // Exact quarantine counts (truncated + garbage + oversize).
    if (countOf(EVENT_TYPES.lineQuarantined) !== 3) {
      throw new Error(`hostile-input: expected 3 quarantines, got ${countOf(EVENT_TYPES.lineQuarantined)}`);
    }
    // Tail resumption: the 5 well-formed message records all mapped through
    // (alien record carries no message; absurd-usage still maps as data).
    if (countOf(EVENT_TYPES.message) !== 5) {
      throw new Error(`hostile-input: expected 5 messages, got ${countOf(EVENT_TYPES.message)}`);
    }
    if (countOf(EVENT_TYPES.usageBlock) !== 2) {
      throw new Error(`hostile-input: expected 2 usage blocks, got ${countOf(EVENT_TYPES.usageBlock)}`);
    }
    // Projections total over the whole hostile log (nothing threw to get here).
    replayFromEmpty(sessionsProjection, grouped);
  },
};
