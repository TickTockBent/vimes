// The cache hit-rate display helper, RELOCATED out of the cache badge (Q4).
//
// WHY IT LEFT THE BADGE: hit rate is a tuning diagnostic the operator cannot
// move, not a session-row metric — the badge now shows observed WARMTH instead
// (last-write age vs TTL tier). The measurement itself is correct; Q4's decision
// is to move it to where its question ("why did this cost what it did") is
// asked: the cost ledger.
//
// WHY IT LANDS HERE, NOT IN THE COST LEDGER YET: the cost ledger's SessionView
// is keyed by the CLAUDE transcript session id, while the cacheObservability
// projection (the source of `cacheHitRate`) is keyed by the VIMES appSessionId
// (costLedgerApi.ts documents this split, with an n:1 title-bridge and a
// first-wins ambiguity). Joining the two therefore needs a new session-key
// mapping / read-model reshape — the §E STOP condition. So the pure helper is
// preserved here with its tests (nothing is deleted, nothing is left dead on the
// badge), ready to be consumed once that join is designed with sign-off.
//
// HONESTY CAVEAT to carry when it lands (Q4's "third hidden time base"): for a
// MIRRORED / adopted session the cumulative rate is cumulative SINCE VIMES
// STARTED WATCHING, not for the session's life — so wherever it renders it must
// be labelled "hit rate (observed)", never presented as whole-session lifetime.
//
// Pure, no clock/DOM/I/O (rule 0.3): every branch is unit-tested without a
// browser.

// Rounded 0..100 hit-rate percent, clamped defensively against an out-of-range
// or non-finite upstream value — a surface never renders a nonsensical percent.
// The projection's own 0..1 division is trusted; this only rounds and clamps it
// for display. (Byte-for-byte the same maths that lived in cacheBadge.ts.)
export function cacheHitRatePercent(cacheHitRate: number): number {
  if (!Number.isFinite(cacheHitRate)) {
    return 0;
  }
  const rounded = Math.round(cacheHitRate * 100);
  return Math.min(100, Math.max(0, rounded));
}
