# ask-user-question fixtures

`no-answer-observed.jsonl` — the observed (rule 0.7) first half of the
AskUserQuestion mechanism, frozen 2026-08-05 from johnny orchestrator
transcript `61bb5ea4` (lines 112/114): an attended AskUserQuestion allowed
with its input UNCHANGED (`updatedInput: pending.input` — the generic gate's
accept path) executes and returns **"The user did not answer the questions."**
with `toolUseResult.answers: {}`. This is what "accept" on the flattened gate
reads as to the asking session — an explicit non-answer, not an error.

The second half was observed 2026-08-05 by the VIMES orchestrator's own
spike (transcript `272f4d57`, two runs): `updatedInput: {...input, answers:
{[questionText]: string}}` delivers the selection — tool_result "Your
questions have been answered: …", model confirms receipt; multiSelect joins
labels with ", " (our encoding, echoed verbatim). See design-directions
"AskUserQuestion needs a first-class question surface" and trial task 3
(`2b8c00ec`), whose AC1 re-confirms the contract under daemon-identical
spawn options.
