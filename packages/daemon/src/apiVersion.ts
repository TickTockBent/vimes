// D84 (open-questions.md, lean (b)): the API-version floor is bundle-declared,
// daemon-checked. This module is the daemon's OWN declaration of what it
// serves — the UI's restatement of the floor it requires lives separately at
// packages/ui/src/lib/apiFloor.ts (no cross-package import; see the precedent
// comment in packages/ui/src/lib/sessionLabel.ts:12-16).
//
// NOT the same fact as EventStore.schemaVersion() (the event-schema version).
// That versions the persisted event shape; this versions the SERVED API shape
// (REST responses + WS envelopes) a UI bundle was built against. The two must
// never be conflated in code or comment — see app.ts's /api/health handler.

// Bumped BY HAND when a served shape (REST response or WS envelope) changes
// incompatibly, or a consumer needs to distinguish. Bumping is a reviewed act,
// part of the unit that changes the shape — never a mechanical/automatic step.
export const DAEMON_API_VERSION = 1;

// The declared capability set. EMPTY at birth (S14 U1): an omitted capability
// means UNSUPPORTED to any client checking it — never "assume yes". Do NOT
// invent capability names for existing features in this unit; a capability is
// added here only in the same unit that makes it meaningfully optional/gated.
export const DAEMON_CAPABILITIES: readonly string[] = [];
