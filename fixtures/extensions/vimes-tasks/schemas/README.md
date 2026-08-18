# `vimes-tasks` schema stubs

Every file here is a **STUB** — a valid, deliberately empty JSON Schema.

The S10·Move-1a manifest parser is PURE (S10-A5): it NAMES these paths
(`[[verbs]].input`, `[[workflows]].record`) and never opens them. They exist as
real files so **Move 1b's registry**, which does own disk access, has something
to resolve, hash and validate against — including the schema-file half of the
#13 authority-property rule (extension-model §2.4 rule 1), which needs to read
`properties` to enforce it.

Their real contents arrive with the migration that gives them a consumer: the
shipped payload shapes live today in `packages/core/src/tasks/workOrder.ts`
(`submitPlanPayloadSchema`, `createTaskToolPayloadSchema`) and
`packages/core/src/schemas.ts`, and the migration map routes them here
(`docs/migration-map.md` §1.2). Filling them ahead of that consumer would be
copying a shape twice — principle 9's exact hazard.
