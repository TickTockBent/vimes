// ci-gate: dependency advisory gate.
//
// Reads `npm audit --json` on stdin. FAILS on high/critical; REPORTS moderate and
// below without failing.
//
// Why the threshold is high rather than zero: the tree carries accepted moderate
// advisories whose reachability has been analysed and recorded (see
// docs/risk-register.md — e.g. a nested @hono/node-server reachable only if an MCP
// transport is started, which nothing does until slice 7). A gate that is red by
// default is a gate people learn to step over, and that is worse than a gate with a
// documented threshold.
//
// ── SCOPED ALLOWLIST (added 2026-07-24, reversing this file's original "no
//    allowlist" stance — deliberately, and with guardrails against the staleness
//    that stance rightly feared). ──────────────────────────────────────────────
//
// A high/critical advisory may be excused ONLY by its specific npm audit `source`
// id (stable numeric id; the GHSA is recorded beside it for humans), and ONLY with
// a written reason pointing at a docs/risk-register.md analysis. The excusal
// CASCADES down the `via`-chain: a package flagged solely because it depends on an
// excused package is itself excused, but a package carrying ANY non-allowlisted
// advisory still fails the gate. Two guardrails keep this honest:
//   1. It is keyed by exact advisory id, never by package name or severity — a NEW
//      advisory on the same package is NOT excused and trips the gate.
//   2. If an allowlisted advisory is no longer present in the audit, the gate
//      prints a NOTE to prune it — a stale entry announces itself instead of
//      silently suppressing.
// The risk register remains the record of WHY; this list is the machine-readable
// tripwire exception, and it is meant to shrink, not grow.
const ALLOWLISTED_ADVISORY_SOURCES = new Map([
  [
    1124334,
    {
      ghsa: 'GHSA-mh99-v99m-4gvg',
      reason:
        'brace-expansion DoS — build/dev/test toolchain ONLY (vite-plugin-pwa/workbox + @vue/test-utils chains); 0 runtime-reachable (daemon pulls none, browser ships workbox-*-runtime not this). A pin is blocked by a dual-major (^2 & ^5) split; npm\'s only "fix" is an SDK-tearing --force downgrade. See docs/risk-register.md (2026-07-24).',
      added: '2026-07-24',
      revisit: 'when the vite-plugin-pwa / @vue/test-utils build chain is next upgraded, or if it ever reaches a runtime dep',
    },
  ],
]);

let rawAuditJson = '';
for await (const chunk of process.stdin) {
  rawAuditJson += chunk;
}

if (rawAuditJson.trim() === '') {
  // No output at all: almost always a registry/network failure rather than a
  // clean tree (a clean tree still prints a JSON body). Treated as SKIPPED, not
  // as a pass — the build must not fail because someone is offline, and it must
  // not silently claim an audit ran when it did not.
  console.error('check-advisories: WARNING — npm audit produced no output; advisory gate SKIPPED (offline?)');
  process.exit(0);
}

let auditReport;
try {
  auditReport = JSON.parse(rawAuditJson);
} catch {
  console.error('check-advisories: WARNING — npm audit output was not JSON; advisory gate SKIPPED');
  process.exit(0);
}

const severityCounts = auditReport?.metadata?.vulnerabilities ?? {};
const criticalCount = severityCounts.critical ?? 0;
const highCount = severityCounts.high ?? 0;
const moderateCount = severityCounts.moderate ?? 0;
const lowCount = severityCounts.low ?? 0;

const vulnerabilities = auditReport?.vulnerabilities ?? {};

// A package is EXCUSED when every advisory it is flagged for traces — directly, or
// transitively through its via-chain — to an allowlisted root advisory. `via`
// entries are either an object (a root advisory, carrying `source`) or a string
// (the name of another package it inherits the flaw from). Fail-safe on a cycle:
// re-entry returns false, so a cycle can only be excused via a genuinely
// allowlisted path, never by referencing itself.
const excusedMemo = new Map();
function isExcused(packageName, ancestry = new Set()) {
  if (excusedMemo.has(packageName)) return excusedMemo.get(packageName);
  if (ancestry.has(packageName)) return false; // cycle guard, fail-safe
  ancestry.add(packageName);
  const advisory = vulnerabilities[packageName];
  const viaEntries = advisory?.via ?? [];
  const excused =
    viaEntries.length > 0 &&
    viaEntries.every((viaEntry) =>
      typeof viaEntry === 'object' && viaEntry !== null
        ? ALLOWLISTED_ADVISORY_SOURCES.has(viaEntry.source)
        : isExcused(viaEntry, ancestry),
    );
  ancestry.delete(packageName);
  excusedMemo.set(packageName, excused);
  return excused;
}

// The blocking set: high/critical packages that are NOT fully excused.
const blockingPackages = Object.entries(vulnerabilities).filter(
  ([packageName, advisory]) =>
    (advisory?.severity === 'high' || advisory?.severity === 'critical') && !isExcused(packageName),
);
const blockingCount = blockingPackages.length;
const excusedHighCritical =
  Object.entries(vulnerabilities).filter(
    ([packageName, advisory]) =>
      (advisory?.severity === 'high' || advisory?.severity === 'critical') && isExcused(packageName),
  ).length;

// Always print the full picture, pass or fail.
console.log(
  `check-advisories: critical=${criticalCount} high=${highCount} moderate=${moderateCount} low=${lowCount}` +
    ` (allowlisted high/critical: ${excusedHighCritical}; blocking: ${blockingCount})`,
);

// Stale-allowlist detection: which allowlisted sources actually appeared.
const seenSources = new Set();
for (const advisory of Object.values(vulnerabilities)) {
  for (const viaEntry of advisory?.via ?? []) {
    if (typeof viaEntry === 'object' && viaEntry?.source != null) seenSources.add(viaEntry.source);
  }
}
for (const [source, meta] of ALLOWLISTED_ADVISORY_SOURCES) {
  if (seenSources.has(source)) {
    console.log(`  ACCEPTED ${meta.ghsa} (source ${source}) — ${meta.reason}`);
  } else {
    console.log(
      `check-advisories: NOTE — allowlisted advisory ${meta.ghsa} (source ${source}) is no longer present; prune it from the allowlist.`,
    );
  }
}

// Per-package detail: mark excused ones so the allowlist's blast radius is visible.
for (const [packageName, advisory] of Object.entries(vulnerabilities)) {
  const severity = advisory?.severity ?? 'unknown';
  if (severity === 'low') continue;
  const titles = (advisory?.via ?? [])
    .filter((viaEntry) => typeof viaEntry === 'object' && viaEntry !== null)
    .map((viaEntry) => viaEntry.title)
    .filter(Boolean);
  const detail = titles.length > 0 ? ` — ${titles.join('; ')}` : '';
  const tag = isExcused(packageName) ? ' [allowlisted]' : '';
  console.log(`  ${severity.padEnd(8)} ${packageName} (${advisory?.range ?? '?'})${detail}${tag}`);
}

if (blockingCount > 0) {
  console.error(
    `check-advisories: FAIL — ${blockingCount} non-allowlisted high/critical advisor${blockingCount === 1 ? 'y' : 'ies'} in the dependency tree.`,
  );
  console.error(
    'check-advisories: fix it, or — if it is genuinely unreachable — record the analysis in docs/risk-register.md and add its advisory source id to ALLOWLISTED_ADVISORY_SOURCES deliberately.',
  );
  console.error(
    'check-advisories: ⚠ do NOT run `npm audit fix --force` here — npm proposes downgrading @anthropic-ai/claude-agent-sdk across a major, which would tear out the SDK the session host depends on.',
  );
  process.exit(1);
}

if (moderateCount > 0) {
  console.log(
    `check-advisories: ${moderateCount} moderate advisor${moderateCount === 1 ? 'y' : 'ies'} present and NOT failing the build — reachability is tracked in docs/risk-register.md.`,
  );
}
