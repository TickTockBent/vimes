import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EVENT_TYPES, dispatchRefused, meterAlert } from '../../events.js';
import {
  burnRatePercentPerHour,
  evaluateHeadroomGate,
  evaluateMeterAlerts,
  headroomPercent,
  meterFreshness,
  projectedExhaustionWithReason,
  rememberMeterAlert,
  type HeadroomGateResult,
  type MeterAlertMemory,
} from '../../meterDerivations.js';
import {
  METER_HISTORY_LIMIT,
  meterHistory,
  meterSample,
  type MetersState,
} from '../../projections/meters.js';
import { readAllStreamsGrouped } from '../../projections/projection.js';
import type { MeterRecord } from '../../schemas.js';
import type { ScenarioProfile } from '../scenario.js';

// ─── budget-wall (spec §7.6) — the slice-5 machine exit gate ─────────────────
//
// REBUILT 2026-07-21 after the finding "slice-5's machine exit gate is GREEN AND
// VACUOUS" (calibration.md). The previous version was the slice-0 stub: it
// emitted `used`/`limit` absolutes from `source: 'jsonl'` (the shape D26
// established the endpoint never gives), carried the deprecated stored `stale`
// flag, hand-emitted a `meter_threshold_crossed` event no production path
// produces, and called a LOCAL headroom stub instead of core's evaluator. It
// exercised none of slice 5, so it could not fail when slice 5 broke.
//
// This version drives the REAL slice-5 path in replay, and it FAILS when any of
// those parts fail — the sabotage check that accompanies it deletes the body of
// `evaluateMeterAlerts` and the profile goes red at stage 4.
//
// Seven stages, each asserted (a violation throws, which is how a profile goes
// red):
//   1. golden fixture → the three endpoint MeterRecords (see the parser-boundary
//      note below)
//   2. samples fold through the REAL meters projection: latest-record-per-meterId
//      and the bounded history
//   3. the REAL pure derivations over the folded state with an INJECTED clock
//   4. a REAL `meter_alert` from `evaluateMeterAlerts`, edge-triggered
//   5. staleness degradation — freshness flips, headroom goes unknown, and NO
//      alert fires on a stale reading even above the threshold (pillar 4, as an
//      executable check)
//   6. headroom refusal through core's `evaluateHeadroomGate`, three-state, with
//      `unknown` NEVER read as permission (I10 groundwork)
//   7. reset re-arm across a real observed rollover
//
// DETERMINISM. Nothing here reads a clock or a random source. The fixture is a
// file on disk; every "now" and every `observedAt` is an explicit ISO literal in
// the timeline below. Double-run byte-identity therefore holds by construction.
//
// ⟨tune PREVIEW⟩ EVERYWHERE. Every number in the CALIBRATION block below is a
// preview band, not a pinned value (rule 0.2). They are the profile's own
// parameters — core still pins nothing.

// ── the parser boundary (stage 1), resolved deliberately ────────────────────
//
// `parseUsageResponse` lives in `packages/daemon` (usageEndpoint.ts) and CANNOT
// be reached from here: the daemon depends on core, so a core→daemon import is a
// cycle. Re-implementing its kind mapping in core would create a SECOND source
// of record for "what the endpoint's limits[] means" (principle 9) — precisely
// the defect this rebuild exists to remove.
//
// So: the profile carries the golden PARSE RESULT as an explicit table, and
// re-reads the captured fixture at run time to verify that table still matches
// the real body field-by-field. The table cannot silently drift from the
// capture, and no mapping logic is duplicated.
//
// CONSEQUENTLY NOT COVERED HERE: `parseUsageResponse` itself — the body→record
// mapping, its unknown-kind tolerance, its degradation paths, and the D26
// used/limit-absence guard. That coverage is daemon-side, in
// `packages/daemon/src/usageEndpoint.test.ts`. budget-wall covers EVERYTHING
// DOWNSTREAM of the parser: the records, the projection, the derivations, the
// alerts, the gate.

const GOLDEN_FIXTURE_RELATIVE_PATH = '../../../../../fixtures/usage/oauth-usage-2026-07-21.json';

// ── CALIBRATION — all ⟨tune PREVIEW⟩, none pinned (rule 0.2) ────────────────
// The crossing level slice 5 previews at 80%.
const ALERT_THRESHOLDS_PERCENT = [80];
// How long an observation stays current. Preview only; slice 5 has not
// calibrated the band, and core deliberately has no default for it.
const STALE_AFTER_MS = 15 * 60 * 1000;
// The headroom a `requireHeadroom` task demands before it may be dispatched.
const REQUIRED_HEADROOM_PERCENT = 30;

// ── the injected timeline (every "now" and every observation) ───────────────
// Chosen to sit inside the golden capture's own day so the fixture's real
// `resets_at` values (session 15:19:59Z, weekly 2026-07-23) stay in the future.
const CAPTURE_OBSERVED_AT = '2026-07-21T12:00:00.000Z';
const SESSION_CLIMB_MID_AT = '2026-07-21T13:00:00.000Z';
const SESSION_CROSSING_AT = '2026-07-21T14:00:00.000Z';
const SESSION_FURTHER_CLIMB_AT = '2026-07-21T15:00:00.000Z';
// No sample lands here — this is the clock advancing past the staleness band
// with the source silent, which is the whole point of stage 5.
const STALENESS_PROBE_NOW = '2026-07-21T15:20:00.000Z';
const ROLLOVER_OBSERVED_AT = '2026-07-21T15:25:00.000Z';
const POST_ROLLOVER_CLIMB_AT = '2026-07-21T15:40:00.000Z';
const POST_ROLLOVER_CROSSING_AT = '2026-07-21T15:55:00.000Z';

// The weekly_all meter is sampled far more often than the history bound, to
// prove the projection's bounded history for real rather than by inspection.
const WEEKLY_SAMPLE_COUNT = METER_HISTORY_LIMIT + 6;
const WEEKLY_SAMPLE_INTERVAL_MS = 60 * 1000;

// ── the endpoint's `resets_at` JITTER, as observed (FINDING 2026-07-21) ─────
//
// The endpoint RECOMPUTES `resets_at` on every request, so one window is
// reported with a different string every poll. This profile used to reuse the
// single golden literal for every session observation — a fixture tidier than
// production, which is exactly why it could not fail when window identity was
// compared by string equality and one 80% crossing sent 33 notifications.
//
// These are the REAL values from the 15:20 window dump, in observed order, with
// the golden capture's own reading first. Note the last one CROSSES A WHOLE
// SECOND (`15:19:59.…` → `15:20:00.…`): a fix that truncates to whole seconds,
// or tolerates only one second, is still broken and this profile must say so.
const SESSION_WINDOW_RESETS_AT_AS_OBSERVED: readonly string[] = [
  '2026-07-21T15:19:59.702520+00:00',
  '2026-07-21T15:19:59.779964+00:00',
  '2026-07-21T15:19:59.801817+00:00',
  '2026-07-21T15:20:00.814087+00:00',
];

// The poll index → the string that poll saw. Deterministic by construction: a
// pure function of the index, no clock and no randomness.
function sessionResetsAtForPoll(pollIndex: number): string {
  return SESSION_WINDOW_RESETS_AT_AS_OBSERVED[
    pollIndex % SESSION_WINDOW_RESETS_AT_AS_OBSERVED.length
  ]!;
}

const SESSION_METER_ID = 'endpoint:session';
const WEEKLY_ALL_METER_ID = 'endpoint:weekly_all';
const WEEKLY_SCOPED_METER_ID = 'endpoint:weekly_scoped:Fable';
// A LOCAL-source meter: attribution only, account-blind (spike U3). It carries
// absolutes and NO percent on purpose — that is the honest shape for a source
// that cannot see account-wide headroom, and it is what stage 6 uses to prove
// `percent-unobserved` yields `unknown` rather than permission.
const LOCAL_ATTRIBUTION_METER_ID = 'jsonl:vimes-hosted-tokens';

// The golden PARSE RESULT: what `parseUsageResponse` produces from
// fixtures/usage/oauth-usage-2026-07-21.json. Cross-checked against the fixture
// by `assertGoldenTableMatchesFixture` below, so it cannot drift from the
// capture. `observedAt` is stamped per sample, not stored here.
interface GoldenEndpointMeter {
  // The raw `kind` string in the fixture's limits[] entry, kept ONLY so the
  // cross-check can find the right entry. Nothing maps it to `record.kind` here.
  endpointKind: string;
  record: Omit<MeterRecord, 'observedAt'>;
}

const GOLDEN_ENDPOINT_METERS: readonly GoldenEndpointMeter[] = [
  {
    endpointKind: 'session',
    record: {
      meterId: SESSION_METER_ID,
      kind: 'rolling-window',
      percent: 29,
      unit: 'percent',
      severity: 'normal',
      isActive: false,
      resetsAt: '2026-07-21T15:19:59.702520+00:00',
      source: 'endpoint',
    },
  },
  {
    endpointKind: 'weekly_all',
    record: {
      meterId: WEEKLY_ALL_METER_ID,
      kind: 'weekly-cap',
      percent: 52,
      unit: 'percent',
      severity: 'normal',
      isActive: false,
      resetsAt: '2026-07-23T16:59:59.702544+00:00',
      source: 'endpoint',
    },
  },
  {
    endpointKind: 'weekly_scoped',
    record: {
      meterId: WEEKLY_SCOPED_METER_ID,
      kind: 'weekly-cap',
      scope: 'Fable',
      percent: 64,
      unit: 'percent',
      severity: 'normal',
      isActive: true,
      resetsAt: '2026-07-23T16:59:59.702854+00:00',
      source: 'endpoint',
    },
  },
];

function fail(message: string): never {
  throw new Error(`budget-wall: ${message}`);
}

function readGoldenFixtureBody(): string {
  const fixtureUrl = new URL(GOLDEN_FIXTURE_RELATIVE_PATH, import.meta.url);
  return readFileSync(fileURLToPath(fixtureUrl), 'utf8');
}

function asPlainObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// The captured body nests the usage object under `response` (alongside the
// `_note`); the live endpoint returns it directly. Both are accepted, and
// nothing outside `limits` is enumerated (rule 0.6 — the top-level codenamed
// buckets churn).
function findLimitsArrayInFixture(fixtureBody: string): unknown[] {
  const topLevel = asPlainObject(JSON.parse(fixtureBody));
  if (topLevel === null) {
    fail('golden fixture is not a JSON object');
  }
  if (Array.isArray(topLevel.limits)) {
    return topLevel.limits;
  }
  const wrappedResponse = asPlainObject(topLevel.response);
  if (wrappedResponse !== null && Array.isArray(wrappedResponse.limits)) {
    return wrappedResponse.limits;
  }
  return fail('golden fixture carries no limits[] array');
}

// The drift guard. It does NOT map the body onto records (that is the daemon
// parser's single job); it checks that every value the golden table claims is
// still literally present in the captured body. If Anthropic's shape moved, or
// the fixture was recaptured, this goes red and someone must reconcile the table
// with `parseUsageResponse` rather than discovering the divergence in
// production.
function assertGoldenTableMatchesFixture(): void {
  const limitEntries = findLimitsArrayInFixture(readGoldenFixtureBody());
  if (limitEntries.length !== GOLDEN_ENDPOINT_METERS.length) {
    fail(
      `golden fixture has ${limitEntries.length} limits[] entries, table expects ${GOLDEN_ENDPOINT_METERS.length}`,
    );
  }
  for (const goldenMeter of GOLDEN_ENDPOINT_METERS) {
    const matchingEntry = limitEntries
      .map(asPlainObject)
      .find((entry) => entry !== null && entry.kind === goldenMeter.endpointKind);
    if (matchingEntry === undefined || matchingEntry === null) {
      fail(`golden fixture has no limits[] entry of kind ${goldenMeter.endpointKind}`);
    }
    if (matchingEntry.percent !== goldenMeter.record.percent) {
      fail(
        `fixture drift: ${goldenMeter.endpointKind} percent is ${String(matchingEntry.percent)}, table says ${String(goldenMeter.record.percent)}`,
      );
    }
    if (matchingEntry.resets_at !== goldenMeter.record.resetsAt) {
      fail(`fixture drift: ${goldenMeter.endpointKind} resets_at moved`);
    }
    if (matchingEntry.severity !== goldenMeter.record.severity) {
      fail(`fixture drift: ${goldenMeter.endpointKind} severity moved`);
    }
    if (matchingEntry.is_active !== goldenMeter.record.isActive) {
      fail(`fixture drift: ${goldenMeter.endpointKind} is_active moved`);
    }
    const scopeObject = asPlainObject(matchingEntry.scope);
    const modelObject = scopeObject === null ? null : asPlainObject(scopeObject.model);
    const fixtureScopeName =
      modelObject === null ? undefined : (modelObject.display_name as string | undefined);
    if (fixtureScopeName !== goldenMeter.record.scope) {
      fail(`fixture drift: ${goldenMeter.endpointKind} scope moved`);
    }
    // D26 GUARD, restated at the profile's own boundary: the endpoint reports
    // percentages only, so no record built here may carry absolutes.
    if ('used' in goldenMeter.record || 'limit' in goldenMeter.record) {
      fail(`${goldenMeter.record.meterId} carries invented absolutes (D26)`);
    }
  }
}

// A fresh observation of an already-known meter. `resetsAt: null` is passed
// EXPLICITLY at rollover (see stage 7) and drops the key, mirroring what the
// live endpoint does.
function observe(
  baseRecord: Omit<MeterRecord, 'observedAt'>,
  observation: { percent: number; observedAt: string; resetsAt?: string | null },
): MeterRecord {
  const nextRecord: MeterRecord = {
    ...baseRecord,
    percent: observation.percent,
    observedAt: observation.observedAt,
  };
  if (observation.resetsAt === null) {
    delete nextRecord.resetsAt;
  } else if (observation.resetsAt !== undefined) {
    nextRecord.resetsAt = observation.resetsAt;
  }
  return nextRecord;
}

function goldenMeterById(meterId: string): Omit<MeterRecord, 'observedAt'> {
  const found = GOLDEN_ENDPOINT_METERS.find(
    (goldenMeter) => goldenMeter.record.meterId === meterId,
  );
  return found === undefined ? fail(`no golden meter ${meterId}`) : found.record;
}

// I10 GROUNDWORK — the ONLY sanctioned reading of a headroom verdict: dispatch
// is permitted by an explicit 'pass' and by nothing else. 'unknown' is not a
// weak yes.
function dispatchAllowedBy(gateResult: HeadroomGateResult): boolean {
  return gateResult.verdict === 'pass';
}

// I10 GROUNDWORK — the defer gate. The dispatcher itself is slice 6; this is the
// pure read a future scheduler makes: has the window this task waits on reset?
export function checkDeferGate(currentTimeIso: string, resetsAtIso: string): { open: boolean } {
  return { open: Date.parse(currentTimeIso) >= Date.parse(resetsAtIso) };
}

export const budgetWall: ScenarioProfile = {
  name: 'budget-wall',
  run(world) {
    const workflowSession = world.registry.createSession({ channel: 'sdk', cwd: '/home/wes/budget' });
    world.registry.spawn('sdk', workflowSession);

    // ── STAGE 1 — the golden capture, as records ────────────────────────────
    assertGoldenTableMatchesFixture();
    const capturedRecords: MeterRecord[] = GOLDEN_ENDPOINT_METERS.map((goldenMeter) => ({
      ...goldenMeter.record,
      observedAt: CAPTURE_OBSERVED_AT,
    }));
    if (capturedRecords.length !== 3) {
      fail(`expected 3 endpoint meters from the golden capture, got ${capturedRecords.length}`);
    }
    world.router.emit(capturedRecords.map(meterSample));

    // A local, account-BLIND attribution meter (U3). Absolutes, no percent —
    // it is not, and must never become, a headroom number.
    const localAttributionRecord: MeterRecord = {
      meterId: LOCAL_ATTRIBUTION_METER_ID,
      kind: 'rolling-window',
      used: 412_000,
      limit: 900_000,
      unit: 'tokens',
      resetsAt: null,
      source: 'jsonl',
      observedAt: CAPTURE_OBSERVED_AT,
    };
    world.router.emit([meterSample(localAttributionRecord)]);

    // ── STAGE 2 — the real projection: latest-per-meterId + bounded history ──
    const weeklyAllBase = goldenMeterById(WEEKLY_ALL_METER_ID);
    const weeklySampleTimestamps: string[] = [];
    const weeklySamples: MeterRecord[] = [];
    for (let sampleIndex = 0; sampleIndex < WEEKLY_SAMPLE_COUNT; sampleIndex += 1) {
      const observedAt = new Date(
        Date.parse(CAPTURE_OBSERVED_AT) + sampleIndex * WEEKLY_SAMPLE_INTERVAL_MS,
      ).toISOString();
      weeklySampleTimestamps.push(observedAt);
      weeklySamples.push(observe(weeklyAllBase, { percent: 52, observedAt }));
    }
    world.router.emit(weeklySamples.map(meterSample));

    const metersAfterWeeklyWalk: MetersState = world.projectionHost.metersState();
    const latestWeeklyRecord = metersAfterWeeklyWalk.meters[WEEKLY_ALL_METER_ID];
    const lastWeeklyTimestamp = weeklySampleTimestamps[weeklySampleTimestamps.length - 1];
    if (latestWeeklyRecord?.observedAt !== lastWeeklyTimestamp) {
      fail('meters projection did not keep the LATEST record per meterId');
    }
    if (Object.keys(metersAfterWeeklyWalk.meters).length !== 4) {
      fail('meters projection lost or invented a meterId');
    }
    const weeklyHistory = meterHistory(metersAfterWeeklyWalk, WEEKLY_ALL_METER_ID);
    // The capture sample plus the walk, bounded: oldest dropped first.
    if (weeklyHistory.length !== METER_HISTORY_LIMIT) {
      fail(`bounded history: expected ${METER_HISTORY_LIMIT} samples, got ${weeklyHistory.length}`);
    }
    const droppedSampleCount = 1 + WEEKLY_SAMPLE_COUNT - METER_HISTORY_LIMIT;
    // One capture sample was emitted before the walk, so the retained window
    // begins `droppedSampleCount - 1` entries into the walk itself.
    const expectedOldestRetainedAt = weeklySampleTimestamps[droppedSampleCount - 1];
    if (weeklyHistory[0]?.observedAt !== expectedOldestRetainedAt) {
      fail('bounded history dropped the wrong end');
    }

    // ── STAGE 3 — the real derivations, injected clock, real values ──────────
    const sessionBase = goldenMeterById(SESSION_METER_ID);
    world.router.emit([
      meterSample(
        observe(sessionBase, {
          percent: 55,
          observedAt: SESSION_CLIMB_MID_AT,
          resetsAt: sessionResetsAtForPoll(1),
        }),
      ),
    ]);
    const metersAtMidClimb = world.projectionHost.metersState();
    const sessionAtMidClimb = metersAtMidClimb.meters[SESSION_METER_ID];

    if (meterFreshness(sessionAtMidClimb?.observedAt, SESSION_CLIMB_MID_AT, STALE_AFTER_MS) !== 'fresh') {
      fail('a just-taken observation must read fresh');
    }
    if (headroomPercent(sessionAtMidClimb) !== 45) {
      fail('headroomPercent must be 100 - observed percent (55 -> 45)');
    }
    // 29% at 12:00 -> 55% at 13:00 is 26 points in one hour, exactly.
    const observedBurnRate = burnRatePercentPerHour(
      meterHistory(metersAtMidClimb, SESSION_METER_ID),
      SESSION_CLIMB_MID_AT,
    );
    if (observedBurnRate !== 26) {
      fail(`burn rate must be 26 %/h over the capture->mid-climb segment, got ${String(observedBurnRate)}`);
    }
    // 45 points left at 26 %/h lands ~1h44m after the 13:00 observation, i.e.
    // ~14:43:51Z — which is BEFORE the window resets at 15:19:59Z, so it is a
    // real projected instant rather than 'resets-first'.
    const projection = projectedExhaustionWithReason(
      sessionAtMidClimb,
      meterHistory(metersAtMidClimb, SESSION_METER_ID),
      SESSION_CLIMB_MID_AT,
    );
    if (projection.reason !== 'projected' || projection.at === null) {
      fail(`exhaustion must project a real instant, got reason ${projection.reason}`);
    }
    if (Date.parse(projection.at) <= Date.parse(SESSION_CLIMB_MID_AT)) {
      fail('projected exhaustion must lie in the future of the observation');
    }
    if (Date.parse(projection.at) >= Date.parse(sessionAtMidClimb?.resetsAt ?? '')) {
      fail('this projection must land before the reset (otherwise the reason would be resets-first)');
    }
    // The local attribution meter has no percent: every headroom-shaped read of
    // it is UNKNOWN, never 0 and never a number.
    if (headroomPercent(metersAtMidClimb.meters[LOCAL_ATTRIBUTION_METER_ID]) !== null) {
      fail('a percent-less local meter must yield null (unknown) headroom, never a number');
    }

    // ── STAGE 4 — a REAL alert, edge-triggered ──────────────────────────────
    let alertMemory: MeterAlertMemory = {};
    const emitAlerts = (metersState: MetersState, nowIso: string): number => {
      const alerts = evaluateMeterAlerts(
        metersState,
        alertMemory,
        ALERT_THRESHOLDS_PERCENT,
        nowIso,
        STALE_AFTER_MS,
      );
      for (const alert of alerts) {
        alertMemory = rememberMeterAlert(alertMemory, alert);
      }
      if (alerts.length > 0) {
        world.router.emit(alerts.map(meterAlert));
      }
      return alerts.length;
    };

    // Below the threshold: nothing to say.
    if (emitAlerts(metersAtMidClimb, SESSION_CLIMB_MID_AT) !== 0) {
      fail('an alert fired below the threshold');
    }

    // 55 -> 85 crosses the ⟨tune PREVIEW⟩ 80% line. Exactly one alert.
    world.router.emit([
      meterSample(
        observe(sessionBase, {
          percent: 85,
          observedAt: SESSION_CROSSING_AT,
          resetsAt: sessionResetsAtForPoll(2),
        }),
      ),
    ]);
    const metersAtCrossing = world.projectionHost.metersState();
    if (emitAlerts(metersAtCrossing, SESSION_CROSSING_AT) !== 1) {
      fail('crossing the threshold must produce EXACTLY ONE meter_alert');
    }

    // Climbing further inside the same window must produce NONE — attention is
    // the scarce resource (pillar 5), so crossing is edge-triggered.
    //
    // AND the window's `resets_at` is re-jittered ACROSS A WHOLE SECOND between
    // these two polls, which is what the live endpoint does. Window identity is
    // a tolerance, not a string comparison; if it ever becomes a string
    // comparison again, this poll re-arms the 80% line and the standing
    // `meter_alert` count at the bottom of this profile goes red.
    world.router.emit([
      meterSample(
        observe(sessionBase, {
          percent: 90,
          observedAt: SESSION_FURTHER_CLIMB_AT,
          resetsAt: sessionResetsAtForPoll(3),
        }),
      ),
    ]);
    if (sessionResetsAtForPoll(3) === sessionResetsAtForPoll(2)) {
      fail('the two in-window polls must carry DIFFERENT resets_at strings (the observed shape)');
    }
    if (sessionResetsAtForPoll(3).slice(0, 19) === sessionResetsAtForPoll(2).slice(0, 19)) {
      fail('the in-window jitter must cross a whole second — truncating seconds is not the fix');
    }
    // The local attribution source keeps reporting on its own cadence (U3: when
    // the endpoint dies, attribution keeps working — it just never becomes
    // headroom). Re-sampled here so stage 6(c) tests a FRESH percent-less meter,
    // isolating `percent-unobserved` from staleness.
    world.router.emit([
      meterSample({
        ...localAttributionRecord,
        used: 517_000,
        observedAt: SESSION_FURTHER_CLIMB_AT,
      }),
    ]);
    const metersAtFurtherClimb = world.projectionHost.metersState();
    if (emitAlerts(metersAtFurtherClimb, SESSION_FURTHER_CLIMB_AT) !== 0) {
      fail('a further climb inside the same window must not re-alert (edge-triggering)');
    }

    // ── STAGE 5 — staleness degradation (the assertion the exit gate names) ──
    // The clock advances past the staleness band with NO new samples: the source
    // went quiet, exactly as it does when the ~6h OAuth token expires.
    const metersWhenStale = world.projectionHost.metersState();
    const staleSessionRecord = metersWhenStale.meters[SESSION_METER_ID];
    if (staleSessionRecord?.percent !== 90) {
      fail('staleness stage must run against the last observed reading (90%)');
    }
    if (meterFreshness(staleSessionRecord.observedAt, STALENESS_PROBE_NOW, STALE_AFTER_MS) !== 'stale') {
      fail('an observation older than the staleness band must read stale');
    }
    const staleGate = evaluateHeadroomGate(
      { meterId: SESSION_METER_ID, pct: REQUIRED_HEADROOM_PERCENT },
      metersWhenStale,
      STALENESS_PROBE_NOW,
      STALE_AFTER_MS,
    );
    if (staleGate.verdict !== 'unknown' || staleGate.reason !== 'observation-stale') {
      fail(`a stale meter must gate UNKNOWN, got ${staleGate.verdict}/${staleGate.reason}`);
    }
    if (staleGate.headroomPercent !== null) {
      fail('a stale reading must never be served as a current headroom number');
    }
    // THE PILLAR-4 PROMISE, EXECUTABLE: 90% is far above the 80% line, and a
    // FRESH memory means nothing suppresses it — yet no alert may fire, because
    // the number can no longer be vouched for. A phone woken by a stale meter is
    // worse than silence.
    const alertsOnStaleReading = evaluateMeterAlerts(
      metersWhenStale,
      {},
      ALERT_THRESHOLDS_PERCENT,
      STALENESS_PROBE_NOW,
      STALE_AFTER_MS,
    );
    if (alertsOnStaleReading.length !== 0) {
      fail('an alert fired on a STALE reading — meters that lie (pillar 4)');
    }

    // ── STAGE 6 — headroom refusal, three-state, unknown is not permission ───
    // (a) FAIL: fresh, observed, and genuinely out of room.
    const freshGate = evaluateHeadroomGate(
      { meterId: SESSION_METER_ID, pct: REQUIRED_HEADROOM_PERCENT },
      metersAtFurtherClimb,
      SESSION_FURTHER_CLIMB_AT,
      STALE_AFTER_MS,
    );
    if (freshGate.verdict !== 'fail' || freshGate.headroomPercent !== 10) {
      fail(`the wall must gate FAIL with 10 points left, got ${freshGate.verdict}/${String(freshGate.headroomPercent)}`);
    }
    world.router.emit([
      dispatchRefused({
        taskId: 'task-requires-headroom',
        reason: `headroom ${freshGate.headroomPercent}% < ${REQUIRED_HEADROOM_PERCENT}% required (${freshGate.reason})`,
      }),
    ]);

    // (b) UNKNOWN via staleness — and unknown DOES NOT ALLOW DISPATCH. The
    // predicate is written the way a future dispatcher (slice 6) must write it:
    // ONLY an explicit pass is permission. `unknown` is not.
    if (dispatchAllowedBy(staleGate)) {
      fail('unknown collapsed into permission to dispatch');
    }
    world.router.emit([
      dispatchRefused({
        taskId: 'task-requires-headroom-while-stale',
        reason: `headroom unknown (${staleGate.reason}) — refusing rather than guessing`,
      }),
    ]);

    // (c) UNKNOWN via an absent percent: the local, account-blind meter. It has
    // absolutes, and they are NOT headroom.
    const localGate = evaluateHeadroomGate(
      { meterId: LOCAL_ATTRIBUTION_METER_ID, pct: REQUIRED_HEADROOM_PERCENT },
      metersAtFurtherClimb,
      SESSION_FURTHER_CLIMB_AT,
      STALE_AFTER_MS,
    );
    if (localGate.verdict !== 'unknown' || localGate.reason !== 'percent-unobserved') {
      fail(`a percent-less meter must gate UNKNOWN/percent-unobserved, got ${localGate.verdict}/${localGate.reason}`);
    }
    world.router.emit([
      dispatchRefused({
        taskId: 'task-requires-headroom-from-local-source',
        reason: `headroom unknown (${localGate.reason}) — local sources are account-blind (U3)`,
      }),
    ]);

    // (d) UNKNOWN because the meter was never observed at all.
    const unseenGate = evaluateHeadroomGate(
      { meterId: 'endpoint:monthly_credit', pct: REQUIRED_HEADROOM_PERCENT },
      metersAtFurtherClimb,
      SESSION_FURTHER_CLIMB_AT,
      STALE_AFTER_MS,
    );
    if (unseenGate.verdict !== 'unknown' || unseenGate.reason !== 'meter-never-observed') {
      fail('a never-observed meter must gate UNKNOWN/meter-never-observed');
    }

    // I10 groundwork, the defer half: a task waiting on the window's reset is
    // refused while the gate is closed.
    const sessionResetsAtIso = staleSessionRecord.resetsAt ?? fail('the session meter lost its resetsAt');
    if (checkDeferGate(SESSION_FURTHER_CLIMB_AT, sessionResetsAtIso).open) {
      fail('the defer gate opened before the reset');
    }
    world.router.emit([
      dispatchRefused({ taskId: 'task-defer-until-reset', reason: 'deferred-until-reset' }),
    ]);

    // ── STAGE 7 — rollover re-arms the threshold ────────────────────────────
    // The REAL observed shape (2026-07-21): at rollover the endpoint sets
    // `percent: 0` and DROPS `resets_at` entirely. Modelled as observed, not as
    // an invented "new resetsAt" that would make re-arming easier than it is.
    world.router.emit([
      meterSample(
        observe(sessionBase, {
          percent: 0,
          observedAt: ROLLOVER_OBSERVED_AT,
          resetsAt: null,
        }),
      ),
    ]);
    const metersAtRollover = world.projectionHost.metersState();
    const rolledOverRecord = metersAtRollover.meters[SESSION_METER_ID];
    if (rolledOverRecord === undefined || rolledOverRecord.resetsAt !== undefined) {
      fail('the rollover sample must carry NO resetsAt (the observed shape)');
    }
    if (headroomPercent(rolledOverRecord) !== 100) {
      fail('a rolled-over window has full headroom');
    }
    if (!checkDeferGate(POST_ROLLOVER_CROSSING_AT, sessionResetsAtIso).open) {
      fail('the defer gate did not open after the reset');
    }
    // The deferred task finally fires: its session spawns, and no refusal.
    const deferredSession = world.registry.createSession({
      channel: 'sdk',
      cwd: '/home/wes/budget-deferred',
      name: 'deferred-task',
    });
    world.registry.spawn('sdk', deferredSession);

    world.router.emit([
      meterSample(
        observe(sessionBase, {
          percent: 40,
          observedAt: POST_ROLLOVER_CLIMB_AT,
          resetsAt: null,
        }),
      ),
    ]);
    const metersAfterRolloverClimb = world.projectionHost.metersState();
    if (emitAlerts(metersAfterRolloverClimb, POST_ROLLOVER_CLIMB_AT) !== 0) {
      fail('an alert fired below the threshold in the new window');
    }
    world.router.emit([
      meterSample(
        observe(sessionBase, {
          percent: 85,
          observedAt: POST_ROLLOVER_CROSSING_AT,
          resetsAt: null,
        }),
      ),
    ]);
    const metersAfterRolloverCrossing = world.projectionHost.metersState();
    // The memory still holds the pre-rollover alert; the window changed, so the
    // threshold is RE-ARMED and fires again. Exactly once.
    if (emitAlerts(metersAfterRolloverCrossing, POST_ROLLOVER_CROSSING_AT) !== 1) {
      fail('the threshold did not re-arm after the window rolled over');
    }

    // ── standing observations over the log ──────────────────────────────────
    const groupedRecords = readAllStreamsGrouped(world.store);
    const countOf = (eventType: string): number =>
      groupedRecords.filter((record) => record.type === eventType).length;
    // Two crossings, two alerts: one per window. `meter_threshold_crossed` is
    // DEPRECATED (calibration.md 2026-07-21) — `meter_alert` is the single
    // source of record for "a meter crossed a line" (principle 9), and this
    // profile, its last producer, no longer emits the old event.
    if (countOf(EVENT_TYPES.meterAlert) !== 2) {
      fail(`expected exactly two meter_alert events, got ${countOf(EVENT_TYPES.meterAlert)}`);
    }
    if (countOf(EVENT_TYPES.meterThresholdCrossed) !== 0) {
      fail('the deprecated meter_threshold_crossed event must have no producer');
    }
    if (countOf(EVENT_TYPES.dispatchRefused) !== 4) {
      fail(`expected exactly four dispatch refusals, got ${countOf(EVENT_TYPES.dispatchRefused)}`);
    }
  },
};
