# Slice 6 — live test plan (2026-07-23)

Everything below runs against the **deployed daemon** (HEAD `3746d23`, restarted
2026-07-23). Ordered by **risk × silence**: the things that fail quietly come
first, because those are the ones that cost you a day before you notice.

Each item says what to do, **what a pass looks like**, **what a failure looks
like**, and what to do about it. Tick them off in any order, but T1 before you
trust anything else.

---

## T1 — Hooks still work ⚠ HIGHEST PRIORITY, FAILS SILENTLY

**Why first.** The hook bearer moved from the `curl` command line into the
environment (`d077324`). Tests prove the command string and the env the daemon
hands each child; **nothing proves Claude Code re-exports `VIMES_HOOK_SECRET`
into the hook subprocess it spawns.** Spike 0a confirmed inheritance for the
**PTY** channel only — the **SDK** channel was never separately confirmed, and
SDK is the default everywhere (D4).

**If this is broken the daemon looks completely healthy and goes deaf**: no
gates, no attention, no notifications. Nothing errors.

**Do:** spawn one session (either channel; **do the SDK one too**, it is the
unverified path) and let it hit a permission prompt — anything needing approval.

**Pass:** the session raises attention in the UI, and the log carries hook
events:
```bash
sqlite3 ~/.vimes/events.db \
  "select type,count(*) from events where type like 'hook_%' group by type;"
# or, if sqlite3 is absent:
journalctl -u vimes.service --since "10 min ago" | grep -i hook
```

**Fail:** zero `hook_*` events after a session that definitely hit a gate, and/or
`401` from the hook ingress in the journal.

**If it fails:** `git revert d077324` → `bash scripts/ci-gate.sh` → restart. The
revert is clean; nothing since depends on it.

---

## T2 — The correction path end-to-end (the kill criterion's verb)

**Why.** This is what slice 6's kill criterion protects, and the recogniser keys
on a shape **measured yesterday** (`commandMode === 'prompt'`). If the CLI
changed the shape, corrections go invisible again.

**Do:** start a session, give it something slow (a long build, a big test run),
then **send a message mid-run** from the composer.

**Pass, in order:**
1. The composer shows **`Correction queued · Ns`** with a ticking counter and
   *"It will be delivered once the current step finishes."*
2. The indicator **clears** when the model actually picks it up.
3. The log carries both halves:
   ```bash
   sqlite3 ~/.vimes/events.db \
     "select type,ts from events where type like 'correction_%' order by seq desc limit 10;"
   ```
4. The worker's behaviour actually changes — it is a *steer*, not a queued
   no-op.

**Fail modes and what each means:**
- Indicator never appears → the two event types are missing from
  `SESSIONS_AFFECTING_TYPES` (a **known-unguarded** line, see the 6b commit), or
  `correction_queued` was not emitted.
- Indicator appears and **never clears** → `correction_delivered` is not being
  recognised. **This is the one that matters**: an uncleared correction protects
  the run from the watchdog forever. Capture the record and re-measure:
  ```bash
  grep -h "queued_command" ~/.claude/projects/*/<session>.jsonl | head -1 | python3 -m json.tool
  ```
  Compare `attachment.commandMode` against `'prompt'`. A third value = a new
  risk-register measurement, not a code patch.

---

## T3 — The watchdog stays quiet on healthy work

**Why.** Slice 6's named halting finding is *"the watchdog quarantines a healthy
run."* It cannot quarantine (that half is unbuilt) but it **can** raise attention
and **push a notification to your phone**, which is the same false positive with
a smaller blast radius.

**Do:** nothing special — just work normally for a few hours with the daemon up.

**Pass:** zero `watchdog_stale` events for runs that were merely thinking, on a
long tool call, or waiting on you at a gate.
```bash
sqlite3 ~/.vimes/events.db \
  "select ts,json_extract(payload,'$.observedSilenceMs'),json_extract(payload,'$.wouldQuarantine')
   from events where type='watchdog_stale' order by seq desc limit 20;"
```

**Fail:** a `watchdog_stale` for a run you know was healthy — **especially one
blocked at a gate.** That is a **rule-0.1 finding: stop and write it up**, do not
tune the band. S3 measured healthy human-gated waits reaching 10 hours; the
protection is supposed to be structural.

**Also worth reading even on a pass:** `wouldQuarantine` is the calibration
column for ⟨tune 3⟩. Every `true` is a run we *would* have killed. That is the
evidence Gate-D needs.

---

## T4 — Task API + dispatcher end-to-end

**Do:** create a task, move it, dispatch it.

```bash
# (through the tunnel, so Access auth applies)
curl -s -X POST https://<host>/api/tasks \
  -H 'content-type: application/json' \
  -d '{"projectRoot":"/home/ticktockbent/projects/<something>","createdBy":"human"}'

curl -s -X POST https://<host>/api/tasks/<id>/transitions \
  -H 'content-type: application/json' \
  -d '{"toStage":"planning","proposedBy":"human"}'

curl -s -X POST https://<host>/api/tasks/<id>/dispatch -d '{}'
```

**Pass:** create returns 201 with `isolation:"worktree"` and `stage:"backlog"`;
the transition returns 200; dispatch returns 200 with `outcome:"spawned"` and a
real `appSessionId` that appears in the session list.

**Check I7 while you are here** — propose an illegal edge (`backlog → done`):
```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST .../transitions \
  -d '{"toStage":"done","proposedBy":"human"}'   # expect 409
sqlite3 ~/.vimes/events.db \
  "select type from events where type='task_transition_rejected' order by seq desc limit 1;"
```
**409 alone is not a pass** — the rejection must be **in the log**. That is the
invariant.

⚠ **The dispatched session will be told NOTHING** (no prompt — deferred to you).
It spawns and sits there. That is expected, not a bug.

---

## T5 — Worktree isolation (only when you want to flip it)

**Currently OFF.** `VIMES_WORKTREE_ISOLATION` is unset → every task runs in
`projectRoot`, so **two tasks in one repo edit the same files.**

**Do:** add `VIMES_WORKTREE_ISOLATION=on` to `/etc/vimes/env`, restart, dispatch a
task, then:
```bash
git -C <projectRoot> worktree list
sqlite3 ~/.vimes/events.db \
  "select json_extract(payload,'$.path'),json_extract(payload,'$.setupMs')
   from events where type='task_worktree_created' order by seq desc limit 5;"
```

**Pass:** a new worktree exists, the session's cwd is that worktree, and
`setupMs` is recorded — **that number is the "untested axis" from the build
order.** If setup is expensive, the per-task override is the escape hatch.

**Fail:** dispatch returns `outcome:"worktree-failed"` → read `detail`; git's own
words are carried verbatim. It will **not** fall back to `projectRoot` — that
refusal is deliberate.

**Note:** nothing removes worktrees. They accumulate until you decide the policy.

---

## T6 — CLI 2.1.218 fixture check (rule 0.6)

The box auto-updated 2.1.217 → 2.1.218 under us. The drift guard is warn-only and
is currently warning on every boot.

**Do:** after any session has run under 2.1.218, compare a fresh transcript's
record shapes against `fixtures/transcripts/`, and a fresh hook payload against
`fixtures/hooks/`.

**Pass:** shapes unchanged → bump `VIMES_EXPECTED_CLI_VERSION` to `2.1.218` and
the boot warning goes away.

**Fail:** any shape drift → refresh the fixtures **first**, in its own reviewed
commit, then bump the pin. Bumping the pin without re-fixturing silences the
guard on an unverified version, which is the one thing it exists to prevent.

---

## T7 — The slice-6 human exit gate (the real one)

**One real feature you actually wanted, moved backlog → done through the board,
where you corrected a worker mid-run and the correction landed without killing
the run.**

Not a demo task. This is the gate, and it is the thing everything above is
rehearsal for. **Blocked on T1 and T2 passing**, and on there being a board to
move it through (step 9) — so realistically this is after the kanban UI.

---

## Known-quiet failure modes (worth a scan even if everything looks fine)

| Symptom | Likely cause |
|---|---|
| Attention never fires | **T1** — hooks deaf |
| Correction indicator never clears | `commandMode` changed; T2 |
| Indicator never appears at all | the unguarded `SESSIONS_AFFECTING_TYPES` line |
| Meters blank / stale | usage endpoint token (401→429 since 22 Jul 15:05) |
| Boot warns about drift | expected until T6 |
