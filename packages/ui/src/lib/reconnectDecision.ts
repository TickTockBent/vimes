// Access-expiry re-auth bounce decision (pure). Cloudflare Access session expiry
// breaks the WS upgrade with a redirect the WS client cannot follow (spec §3.10 /
// §3.11). After a few consecutive WS failures the store probes GET /api/health;
// this function turns the probe outcome into an action:
//
//   'reload'        → Access is intercepting (redirect / opaque / non-OK): do a
//                     full-page navigation so the browser follows the login flow,
//                     then the store resubscribes with per-stream lastSeq.
//   'keep-retrying' → the daemon is simply unreachable (network down) or healthy
//                     (a transient WS hiccup): keep the backoff reconnect loop.

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
  // opaqueredirect) or an opaque cross-origin response, or any non-OK status.
  if (outcome.redirected === true) {
    return 'reload';
  }
  if (outcome.type === 'opaque' || outcome.type === 'opaqueredirect') {
    return 'reload';
  }
  if (outcome.ok === false) {
    return 'reload';
  }
  // A clean 200 from our own origin: auth is fine, the WS trouble is transient.
  return 'keep-retrying';
}
