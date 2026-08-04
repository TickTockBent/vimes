// Access-expiry re-auth bounce decision (pure). Cloudflare Access session expiry
// breaks the WS upgrade with a redirect the WS client cannot follow (spec §3.10 /
// §3.11). After a few consecutive WS failures the store probes GET /api/health;
// this function turns the probe outcome into an action:
//
//   'reload'        → Access is intercepting (redirect / opaque / 401 / 403): do a
//                     full-page navigation so the browser follows the login flow,
//                     then the store resubscribes with per-stream lastSeq.
//   'keep-retrying' → the daemon is simply unreachable (network down) or healthy
//                     (a transient WS hiccup): keep the backoff reconnect loop.
//
// The rule: reload iff the probe shows Access-shaped interception; an unreachable
// or unhappy origin keeps the backoff loop — reloading during an outage renders
// the infrastructure error page (observed 2026-08-04).

export type ReconnectAction = 'reload' | 'keep-retrying';

// The distilled result of the /api/health probe. `fetchFailed` is true when fetch
// itself rejected (network error) — distinct from a resolved-but-unhappy response.
export interface HealthProbeOutcome {
  fetchFailed: boolean;
  ok?: boolean;
  redirected?: boolean;
  // response.type: 'basic' | 'cors' | 'opaque' | 'opaqueredirect' | 'error'.
  type?: string;
  status?: number;
}

// How many consecutive WS connection failures before we probe /api/health. Two:
// one failure can be a transient blip; two in a row is worth a probe.
export const RECONNECT_PROBE_THRESHOLD = 2;

export function shouldProbeHealth(consecutiveFailures: number): boolean {
  return consecutiveFailures >= RECONNECT_PROBE_THRESHOLD;
}

export function decideReconnectAction(outcome: HealthProbeOutcome): ReconnectAction {
  // A network-level failure means the daemon is unreachable, NOT that Access is
  // intercepting — keep retrying with backoff.
  if (outcome.fetchFailed) {
    return 'keep-retrying';
  }
  // Access intercepting shows up as a redirect to the login page (redirected /
  // opaqueredirect) or an opaque cross-origin response.
  if (outcome.redirected === true) {
    return 'reload';
  }
  if (outcome.type === 'opaque' || outcome.type === 'opaqueredirect') {
    return 'reload';
  }
  // Access denying without a redirect: 401/403 are the only statuses that mean
  // "authenticate", so they are the only statuses that earn a reload.
  if (outcome.status === 401 || outcome.status === 403) {
    return 'reload';
  }
  // Everything else — a clean 200, or an unhappy origin (500/502/503/504, or the
  // tunnel's own error page) — keeps the backoff loop running.
  return 'keep-retrying';
}
