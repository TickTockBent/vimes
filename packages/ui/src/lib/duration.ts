// The single deterministic, LOCALE-FREE elapsed-duration formatter shared by the
// usage-meters strip (meterDisplay.ts) and the cache-warmth badge
// (cacheBadge.ts). It lived inlined in meterDisplay.ts; it is extracted here so
// both surfaces render "26m" the SAME way (principle 9 — the Q4 defect existed
// because two halves of one badge disagreed about a fact, and a second copy of
// the age formatter would invite the same drift).
//
// No Intl/toLocaleString and no clock read (rule 0.3 determinism carries into
// the UI's pure derivations): the caller passes a span in, and the same span
// yields the same string in every timezone and locale. Input must be a
// non-negative span; callers handle <= 0 (e.g. clock-skew "just now") themselves.
export function formatDuration(spanMs: number): string {
  const totalSeconds = Math.floor(spanMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const totalHours = Math.floor(totalMinutes / 60);
  const remainderMinutes = totalMinutes % 60;
  if (totalHours < 24) {
    return `${totalHours}h ${remainderMinutes}m`;
  }
  const totalDays = Math.floor(totalHours / 24);
  const remainderHours = totalHours % 24;
  return `${totalDays}d ${remainderHours}h`;
}
