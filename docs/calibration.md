# Calibration — the measurement record

Pinned budgets and bands, probe/spike results, and the methods that
produced them. Bands are pinned *with their assumptions* (workload, host,
harness version), never as bare numbers, never unreviewed (Gate-D, rule
0.2). Opened 2026-09-08 at the pivot (D1).

**Nothing is pinned yet.** Vimes measurements that still describe a
surviving surface — the usage-meter derivations, cache-tier
classification (Spike C), the git porcelain probe (Spike G), the SDK
transcript fixtures — stay live in the archive's
[`vimes/calibration.md`](vimes/calibration.md) and are cited from there;
a re-measurement supersedes by a new entry **here** naming the archive
entry it replaces.

## ⟨tune⟩ placeholders awaiting Gate-D

| Placeholder | v0 relative weight (measurement only) | Pins at | Assumption to record with the pin |
|---|---|---|---|
| `retry_bound` — schema-rejected report retries per node (Q10) | 2 | slice 1 Gate-D, after SP1·1(b) | harness + version the rejection behaviour was observed on; brief-delta form used |
| grant default when a node declares none (slice-1 §3.1) | status quo (closed tool allowlist, unscoped paths) | slice 1 Gate-D | which shipped nodes carry an explicit grant at the real run |

## Spike results

*(SP1·1's four observations land here — (a) path-scoped grant
enforcement, (b) schema-invalid report at the door, (c) transcript
retrievability for a failed attempt, (d) per-node model/effort — each
with the SDK and vendored-CLI versions it was observed on.)*
