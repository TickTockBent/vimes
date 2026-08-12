// D84 (open-questions.md, lean (b)): the API-version floor is BUNDLE-declared,
// daemon-checked. This is this bundle's restatement of the daemon API version
// it was built against — `@vimes/core` (and the daemon's own
// `packages/daemon/src/apiVersion.ts`) is deliberately NOT a dependency of
// packages/ui (see the header of lib/types.ts), so the number is RESTATED
// here rather than imported, in the same posture as `sessionLabel.ts:12-16`
// and `costDisplay.ts`'s `NANO_DOLLARS_PER_CENT`. Keep the two in step by
// hand; nothing enforces it mechanically.
//
// BUMP RULE: raise this in the SAME unit that makes the UI consume a daemon
// shape (REST response or WS envelope) that did not exist at the old floor —
// never as a drive-by. A daemon serving an apiVersion below this number is a
// stale daemon relative to what this bundle needs (App.vue renders the
// mismatch banner); a daemon serving this number or higher is fine, additive
// changes need no bump.
export const UI_REQUIRED_API_VERSION = 1;

// Pure decision, kept out of the Pinia store on purpose (same posture as
// reconnectDecision.ts's decideReconnectAction) so it is unit-testable without
// standing up a WebSocket. `daemonApiVersion` is null until the hello frame
// (D84) arrives on the CURRENT connection; `hasRespondedThisConnection` is
// true once at least one `subscribed` ack has been seen on it — the
// proof-of-life that turns "no hello yet" (ambiguous — it may just not have
// arrived) into "no hello ever" (conclusive — an anchor-frame daemon that
// predates the hello op entirely, exactly the stale-daemon condition D84
// exists for).
export function daemonApiVersionMismatch(
  daemonApiVersion: number | null,
  hasRespondedThisConnection: boolean,
): boolean {
  if (daemonApiVersion === null) {
    return hasRespondedThisConnection;
  }
  return daemonApiVersion < UI_REQUIRED_API_VERSION;
}

// An omitted capability (daemon hasn't said hello yet, OR said hello without
// naming it) is UNSUPPORTED — never "assume yes" (apiVersion.ts's daemon-side
// comment states the same rule from the other end of the wire).
export function daemonSupportsCapability(
  daemonApiVersion: number | null,
  capabilities: readonly string[],
  capability: string,
): boolean {
  return daemonApiVersion !== null && capabilities.includes(capability);
}
