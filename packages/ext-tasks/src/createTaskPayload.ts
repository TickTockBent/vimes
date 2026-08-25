// ─── the `create_task` tool payload — the tenant's authoring door ─────────────
//
// SPLIT OUT OF `packages/core/src/tasks/workOrder.ts` BY S18·U2 (Move 4,
// `docs/slice-18.md` §3.4). It was the one shape in that module with NO core
// consumer — the daemon's `createTaskTool.ts` was its only reader (§0.2,
// verified) — and what it encodes is TENANT VOCABULARY: which work-order fields
// a task-authoring MODEL may name, and which the daemon decides for it. The
// engine-bound shapes it used to sit beside (the stage-run identity tuple,
// `submitPlanPayloadSchema`, the two report payloads) STAYED in core, held there
// by `events.ts`'s runtime payload validation — §3.4's named compatibility
// surface (c1), each with its own death trigger.
//
// ⚠ The declaration below is the ORIGINAL BYTES, doctrine comment included, and
// its `── 7.` section number is kept ON PURPOSE: every cross-reference to
// "workOrder.ts section 7" still lands on the same text, and workOrder.ts keeps
// a stub at that position pointing here (the same courtesy S7·7b's hoist paid
// its own sections 4/5).
//
// Direction: this module → zod, and NOTHING else. It needs nothing from the
// engine, so it does not reach for `@vimes/ext-host` either.

import { z } from 'zod';

// ── 7. createTaskToolPayloadSchema — the `create_task` MCP tool payload ───────
//
// S8·6 (D56's author grant, D65's `vimes_board`). The shape a STANDING
// ORCHESTRATOR's `create_task` call takes, validated IN-RUN inside the
// orchestrator's own turn (D44's retry-locality argument, applied to authoring:
// an invalid payload bounces back as a tool result and the model fixes it in
// conversation, rather than failing after the fact where nobody can act on it).
//
// ⚠ **WHAT IS ABSENT IS THE WHOLE DESIGN.** There is no `projectRoot`, no
// `stage`, no `isolation`, no `gates` and no `createdBy` here. Every one of those
// is FORCED SERVER-SIDE by the daemon's tool handler: the project comes from the
// orchestrator's own `orchestratorForProjectId` (so it can never author across
// the project fence), the stage is always `backlog` (promotion is a human's
// decision, D53), and `createdBy` is always `orchestrator` (a caller that could
// name its own provenance could author as a human). Principle 13: no tool
// parameter may assert what the daemon decides.
//
// ⚠ **`.strict()`, AND THE CHOICE IS DELIBERATE — REJECT, NEVER SILENTLY STRIP.**
// A payload carrying `stage: 'implementing'` is a model that BELIEVES it can name
// a stage. Stripping the key would let that call "succeed" while the belief
// survives into the next turn and into the standing notes — which is exactly the
// confabulation shape the walk-2 finding recorded. So an alien key is a
// validation ERROR naming the field, and the model is TOLD its parameter does not
// exist. Zero events are written on that path.
//
// ⚠ **THE CRITERION SHAPE IS `{ text }` — TEXT ONLY, NO id**, the same shape the
// human create door takes and for the same reason: a criterion id is stable
// identity that `report_review` keys per-criterion verdicts to, so it is MINTED
// SERVER-SIDE in `TaskWriter.createTask` (see the `CreateTaskInput` note there).
// The inner object is `.strict()` too, so a model that tries to hand-type an id
// is told the parameter does not exist rather than having it dropped.
//
// Every field but `explicitlyOut` is REQUIRED and non-empty — the authoring
// doctrine in the founding briefing asks for a real scope, real checkable
// criteria and a real kill condition, and a schema that accepted a work-order
// without them would be contradicting the words in the same breath. Consumer:
// the daemon's `buildCreateTaskSpec` (S8·6).
export const createTaskToolPayloadSchema = z
  .object({
    title: z.string().min(1),
    scope: z.string().min(1),
    // The one OPTIONAL field: a work-order with nothing worth fencing off is a
    // real work-order, and an empty list would be a claim rather than a silence.
    explicitlyOut: z.array(z.string().min(1)).optional(),
    acceptanceCriteria: z.array(z.object({ text: z.string().min(1) }).strict()).min(1),
    killCriterion: z.string().min(1),
  })
  .strict();
export type CreateTaskToolPayload = z.infer<typeof createTaskToolPayloadSchema>;
