# ask-user-question fixtures

`no-answer-observed.jsonl` — the observed (rule 0.7) first half of the
AskUserQuestion mechanism, frozen 2026-08-05 from johnny orchestrator
transcript `61bb5ea4` (lines 112/114): an attended AskUserQuestion allowed
with its input UNCHANGED (`updatedInput: pending.input` — the generic gate's
accept path) executes and returns **"The user did not answer the questions."**
with `toolUseResult.answers: {}`. This is what "accept" on the flattened gate
reads as to the asking session — an explicit non-answer, not an error.

The second half (returning `updatedInput` with a populated `answers` map and
observing the selection land in the tool result) is the spike gating the
question-surface unit — see design-directions "AskUserQuestion needs a
first-class question surface" (scheduled post-slice-8).
