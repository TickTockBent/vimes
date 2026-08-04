// Service-worker navigation fallback decision (pure). A navigation request whose
// origin is down would otherwise render the infrastructure error page — the daemon
// restarting behind the Cloudflare tunnel replaced the open app with a raw 502
// (observed 2026-08-04). The app shell must outlive the daemon: the shell boots,
// the store's backoff loop reconnects, and the "Reconnecting…" banner tells the
// truth in the meantime.

export type NavigationResponsePlan = 'network' | 'cached-shell';

// The distilled result of the navigation fetch. `fetchRejected` is true when fetch
// itself rejected (network error); `status` is present only when it resolved.
export interface NavigationFetchOutcome {
  fetchRejected: boolean;
  status?: number;
}

export function decideNavigationResponse(outcome: NavigationFetchOutcome): NavigationResponsePlan {
  if (outcome.fetchRejected) {
    return 'cached-shell';
  }
  // 5xx is the tunnel or the origin failing, never the origin speaking.
  if (outcome.status !== undefined && outcome.status >= 500) {
    return 'cached-shell';
  }
  // Everything else passes through. 4xx MUST pass through: a 401/403 from Access is
  // the login flow, and masking it with the cached shell would brick auth; a genuine
  // 404 is the origin speaking.
  return 'network';
}
