// ci-gate: dependency advisory gate.
//
// Reads `npm audit --json` on stdin. FAILS on high/critical; REPORTS moderate and
// below without failing.
//
// Why the threshold is high rather than zero: the tree carries accepted moderate
// advisories whose reachability has been analysed and recorded (see
// docs/risk-register.md — today, a nested @hono/node-server reachable only if an
// MCP transport is started, which nothing does until slice 7). A gate that is red
// by default is a gate people learn to step over, and that is worse than a gate
// with a documented threshold. Anything high or critical stops the build; a new
// moderate shows up in the output where it will be seen and triaged.
//
// This script is deliberately dumb about WHICH advisories are acceptable — it
// keeps no allowlist. An allowlist would need pruning to stay honest, and a stale
// allowlist silently suppresses real findings. The risk register is the record;
// this gate is the tripwire.

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

const blockingCount = criticalCount + highCount;

// Always print the full picture, pass or fail — the moderates are the ones a
// human needs to keep an eye on, so they must never be invisible.
console.log(
  `check-advisories: critical=${criticalCount} high=${highCount} moderate=${moderateCount} low=${lowCount}`,
);

const vulnerablePackages = Object.entries(auditReport?.vulnerabilities ?? {});
for (const [packageName, packageAdvisory] of vulnerablePackages) {
  const severity = packageAdvisory?.severity ?? 'unknown';
  if (severity === 'low') {
    continue;
  }
  const titles = (packageAdvisory?.via ?? [])
    .filter((viaEntry) => typeof viaEntry === 'object' && viaEntry !== null)
    .map((viaEntry) => viaEntry.title)
    .filter(Boolean);
  const detail = titles.length > 0 ? ` — ${titles.join('; ')}` : '';
  console.log(`  ${severity.padEnd(8)} ${packageName} (${packageAdvisory?.range ?? '?'})${detail}`);
}

if (blockingCount > 0) {
  console.error(
    `check-advisories: FAIL — ${blockingCount} high/critical advisor${blockingCount === 1 ? 'y' : 'ies'} in the dependency tree.`,
  );
  console.error(
    'check-advisories: fix it, or — if it is genuinely unreachable — record the analysis in docs/risk-register.md and reassess the threshold deliberately.',
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
