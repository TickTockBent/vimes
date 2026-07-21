import { EVENT_TYPES, dispatchRefused, message, meterThresholdCrossed } from '../../events.js';
import { meterSample, type MetersState } from '../../projections/meters.js';
import { readAllStreamsGrouped } from '../../projections/projection.js';
import type { MeterRecord } from '../../schemas.js';
import type { ScenarioProfile } from '../scenario.js';

// budget-wall (spec §7.6): meters approach a cap; a threshold crossing is evented;
// a requireHeadroom task is refused against the meters projection (I10 hardens
// slice 5); a deferUntilReset task fires only after the injected clock passes
// resetsAt. No task state machine here (slice 6) — the dispatcher is a stub whose
// only duty is the gate-check + the refusal/threshold events.
const METER_ID = 'window-5h';
const METER_LIMIT = 1000;
const THRESHOLD_PCT = 80; // ⟨tune PREVIEW⟩ — nothing pinned in slice 0.
const RESET_DELTA_MS = 3000;

function usageMeter(used: number, observedAt: string): MeterRecord {
  return {
    meterId: METER_ID,
    kind: 'rolling-window',
    scope: 'all-models',
    modelFamily: null,
    used,
    limit: METER_LIMIT,
    unit: 'tokens',
    resetsAt: null,
    source: 'jsonl',
    observedAt,
    stale: false,
  };
}

// TYPE-ONLY narrowing after D26 made `used`/`limit` optional (a source may give
// percentages only). This profile still emits absolutes, so every value it feeds
// in is a number and the arithmetic below is unchanged — no event payload, no
// assertion, and no emitted byte in this profile differs.
function observedPct(metersState: MetersState, meterId: string): number {
  const meter = metersState.meters[meterId];
  const usedAmount = meter?.used;
  const limitAmount = meter?.limit;
  if (typeof usedAmount !== 'number' || typeof limitAmount !== 'number' || limitAmount === 0) {
    return 0;
  }
  return (usedAmount / limitAmount) * 100;
}

// Stub dispatcher — gate-check only. Headroom: dispatch is allowed only while the
// meter sits below the ceiling pct; at or above, it is refused.
export function checkHeadroomGate(
  metersState: MetersState,
  gate: { meterId: string; pct: number },
): { allowed: boolean; observedPct: number } {
  const pct = observedPct(metersState, gate.meterId);
  return { allowed: pct < gate.pct, observedPct: pct };
}

// Stub dispatcher — the defer gate opens once the injected clock reaches resetsAt.
export function checkDeferGate(currentTimeIso: string, resetsAtIso: string): { open: boolean } {
  return { open: Date.parse(currentTimeIso) >= Date.parse(resetsAtIso) };
}

export const budgetWall: ScenarioProfile = {
  name: 'budget-wall',
  run(world) {
    const workflowSession = world.registry.createSession({ channel: 'sdk', cwd: '/home/wes/budget' });
    world.registry.spawn('sdk', workflowSession);

    // Walk the rolling-window meter toward its cap; cross the threshold once.
    const walk = [200, 500, 700, 860];
    let hasCrossed = false;
    for (let index = 0; index < walk.length; index += 1) {
      const observedAt = `2026-01-01T00:0${index}:00.000Z`;
      world.router.emit([meterSample(usageMeter(walk[index]!, observedAt))]);
      const pct = observedPct(world.projectionHost.metersState(), METER_ID);
      if (!hasCrossed && pct > THRESHOLD_PCT) {
        hasCrossed = true;
        world.router.emit([meterThresholdCrossed({ meterId: METER_ID, pct })]);
      }
    }
    if (!hasCrossed) {
      throw new Error('budget-wall: meter never crossed its threshold');
    }

    // requireHeadroom task: refused against the current meters projection (I10).
    const headroom = checkHeadroomGate(world.projectionHost.metersState(), {
      meterId: METER_ID,
      pct: THRESHOLD_PCT,
    });
    if (headroom.allowed) {
      throw new Error('budget-wall: headroom gate should have refused at the wall');
    }
    world.router.emit([
      dispatchRefused({
        taskId: 'task-requires-headroom',
        reason: `usage ${headroom.observedPct.toFixed(1)}% >= ${THRESHOLD_PCT}% ceiling`,
      }),
    ]);

    // deferUntilReset task: emit one tick to read "now", set reset in the future.
    const tick = (): string => {
      const [record] = world.router.emit([
        message({ appSessionId: workflowSession, role: 'system', content: 'tick' }),
      ]);
      return record!.ts;
    };
    let currentTimeIso = tick();
    const resetsAtIso = new Date(Date.parse(currentTimeIso) + RESET_DELTA_MS).toISOString();

    // First attempt: before reset -> gate closed -> refused.
    if (checkDeferGate(currentTimeIso, resetsAtIso).open) {
      throw new Error('budget-wall: defer gate opened before reset');
    }
    world.router.emit([
      dispatchRefused({ taskId: 'task-defer-until-reset', reason: 'deferred-until-reset' }),
    ]);

    // Advance the injected clock past resetsAt (each tick steps it forward).
    while (Date.parse(currentTimeIso) < Date.parse(resetsAtIso)) {
      currentTimeIso = tick();
    }

    // Second attempt: reset reached -> gate open -> the task fires (its session
    // spawns). No refusal this time.
    if (!checkDeferGate(currentTimeIso, resetsAtIso).open) {
      throw new Error('budget-wall: defer gate did not open after reset');
    }
    const deferredSession = world.registry.createSession({
      channel: 'sdk',
      cwd: '/home/wes/budget-deferred',
      name: 'deferred-task',
    });
    world.registry.spawn('sdk', deferredSession);

    // Observations: exactly one threshold crossing, two refusals (headroom + defer).
    const grouped = readAllStreamsGrouped(world.store);
    const countOf = (type: string): number => grouped.filter((r) => r.type === type).length;
    if (countOf(EVENT_TYPES.meterThresholdCrossed) !== 1) {
      throw new Error('budget-wall: expected exactly one threshold crossing');
    }
    if (countOf(EVENT_TYPES.dispatchRefused) !== 2) {
      throw new Error('budget-wall: expected exactly two dispatch refusals');
    }
  },
};
