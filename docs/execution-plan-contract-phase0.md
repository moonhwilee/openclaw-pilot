# Execution Plan Contract Phase 0 Audit

Status: implementation prep
Branch: `gb/execution-plan-contract`
Date: 2026-06-01

This is the Phase 0 map for replacing Pilot's mixed approval/request-text
authorization path with a typed `execution_plan` contract.

No runtime behavior changes are included in Phase 0. This document freezes the
unsafe paths, current test dependencies, and replacement assertions before the
boundary switch starts.

## Goal-Mode Simulation Contract

This refactor is being operated like a `/goal` run:

```text
plan -> approved scope -> execute phase -> verify phase -> converge if needed -> report
```

The process is manual orchestration, not a real Pilot `/goal` invocation. We do
not need to write Pilot state JSON artifacts for this meta-work. The important
part is preserving the same execution discipline:

- explicit scope before edits;
- no execution outside the approved refactor boundary;
- every phase has acceptance checks;
- stop rather than widening when a boundary is unclear;
- visible completion report after tool-heavy work.

## Current Unsafe Authorization Paths

### Approval-Time Request Classification

File: `src/approval/run.ts`

- `isPilotReceiptsDashboardRequest` at line 54 selects dashboard capability from
  request prose.
- `hasLocalFileReference` at line 59 and `asksToMutateLocalFile` at line 65
  detect local file mutation intent from raw text.
- `isRunnerBackedGoalRequest` at line 89 selects runner execution from raw
  tokens such as `implement`, `fix`, `test`, `runner`, `codex`, and Korean
  equivalents.
- `approvedExecutionBoundary` at line 107 synthesizes `approved_scope`,
  `approved_capabilities`, and `next_action`.
- `recordApproval` at line 161 writes the synthesized capability into
  `PilotApprovalEntry`.

Replacement assertion:

- `approve <Run>` must load `execution-plan.json`, validate it, compute/store
  `execution_plan_hash`, and record approval of that exact contract.
- It must not classify request prose or synthesize execution capability.

### Route-Level Executable Request Reconstruction

File: `src/route/run.ts`

- `approvedPlanContract` at line 861 rebuilds a human plan from
  `entry.approved_capabilities`.
- `writeApprovedGoalRequest` at line 993 derives `createsDashboard` and
  `runsSession` from `entry.approved_capabilities`.
- The same function writes `approved-goal-request.json` at line 1035.
- The reconstructed request sets both `approval.approved_capabilities` and
  `preflight.typed_capabilities` from the approval entry.

Replacement assertion:

- Route execution must load the approved `execution_plan` by ref/hash.
- If a derived request object remains temporarily necessary for runner APIs, it
  must be mechanically derived from the approved execution plan, not raw prose
  or old approval capabilities.
- `approved-goal-request.json` must stop being an authorization artifact.

### Goal Execution Loop

File: `src/goal/run.ts`

- `approvalCoversCapabilities` at line 39 compares
  `approval.approved_capabilities` to `preflight.typed_capabilities`.
- The execution loop at line 140 iterates
  `request.preflight.typed_capabilities`.
- Lineage metadata at line 470 records `preflight.typed_capabilities` as the
  executed capability source.

Replacement assertion:

- Execution must iterate `execution_plan.steps`.
- The capability runner is selected from `step.capability`.
- Receipts and goal steps must include `execution_step_id`.
- `preflight.typed_capabilities` can only be derived metadata during migration,
  never the execution source.

### Schema Coupling To Old Authorization

File: `src/schema/index.ts`

- `validateGoalRequest` requires `preflight.typed_capabilities` at line 219.
- It validates each typed capability at line 229.
- It requires `approval.approved_capabilities` at line 245.
- It compares approved capability to preflight capability at line 254.

Replacement assertion:

- Add `validateExecutionPlan`.
- Move executable capability validation to `execution_plan.steps`.
- Keep broad-grant rejection and dangerous capability rejection.
- If `GoalRequest` remains for compatibility, its old fields must not be
  treated as authorization.

### Types That Need Migration

File: `src/types.ts`

- `GoalApproval.approved_capabilities` currently models approved capability as
  first-class authorization.
- `GoalPreflight.typed_capabilities` currently models executable capability as
  first-class authorization.
- `PilotApprovalEntry.approved_capabilities` currently persists the approved
  executable capability.
- `TypedReceipt` has `step?: number`, but no `execution_step_id`.

Replacement assertion:

- Add `ExecutionPlan` and `ExecutionStep`.
- Add approval fields such as `execution_plan_ref` and
  `execution_plan_hash`.
- Add `execution_step_id` to receipts and goal steps.
- Leave old fields only as temporary derived/compatibility metadata while the
  boundary switch is in progress.

## Current Tests That Depend On Legacy Behavior

### `tests/route.test.ts`

Legacy-dependent assertions:

- Around line 798, approve route reads `approved-goal-request.json` and expects
  `approved_capabilities: ["create_artifact"]`.
- Around line 845, dashboard approval expects both
  `approval.approved_capabilities` and `preflight.typed_capabilities` to be
  `["create_pilot_receipts_dashboard"]`.
- Around line 909, runner approval expects
  `approval.approved_capabilities: ["run_codex_session"]`.
- Around line 1005, freeform local file creation approval expects
  `approved-goal-request.json` and runner capability chosen from request text.

Replacement assertions:

- Approved plan has `execution-plan.json`.
- `approve <Run>` records `execution_plan_hash`.
- Dashboard and runner flows execute from typed execution steps.
- Tampering with `execution-plan.json` after approval blocks before runner.
- Old `approved-goal-request.json` assertions are removed or changed to derived
  compatibility assertions that are not authorization proof.

### `tests/goal.test.ts`

Legacy-dependent setup:

- `baseGoalRequest` uses `preflight.typed_capabilities`.
- Approved cases set `approval.approved_capabilities`.
- Capability registry alignment test mutates `preflight.typed_capabilities`.
- Dangerous capability rejection uses `preflight.typed_capabilities` plus
  `approval.approved_capabilities`.
- Runner tests set `preflight.typed_capabilities = ["run_codex_session"]`.

Replacement assertions:

- Base approved execution fixtures include `execution_plan.steps`.
- Approval required test still shows no execution before approval.
- Approved execution tests assert step id, capability, receipt, and verification
  all trace back to `execution_plan.steps`.
- Unsupported/dangerous capability rejection is tested through
  `validateExecutionPlan`.
- Runner disabled and runner success tests execute only when the typed step is
  present.

## Direct CLI / Fixture Bypass Risks

Current direct `pilot goal <goal-request.json>` style tests can bypass plan
generation and approval records.

Replacement policy:

- Direct fixture tests may remain only if the fixture includes a valid
  `execution_plan` and approved execution-plan hash/ref.
- Direct fixtures without `execution_plan` must stop with replan-required or
  invalid-request behavior.
- No direct fixture may execute from `approved_capabilities` or
  `preflight.typed_capabilities`.

## No-Legacy / No-Fallback Gates

Implementation is not complete until these are true:

- `src/approval/run.ts` does not call request-text classifiers on the approval
  path.
- `src/route/run.ts` does not choose `create_artifact`,
  `create_pilot_receipts_dashboard`, or `run_codex_session` from request prose
  or old approval capabilities.
- `src/goal/run.ts` does not loop over `preflight.typed_capabilities`.
- Missing `execution-plan.json` returns replan-required / fail-closed behavior.
- Hash mismatch blocks before any runner starts.
- Recovery/resume refuses to execute old approved capabilities.

## Phase 1 Starting Points

Recommended first files for the next phase:

- `src/types.ts`: add `ExecutionPlan`, `ExecutionStep`, approval hash/ref
  fields, and receipt `execution_step_id`.
- `src/schema/index.ts`: add `validateExecutionPlan` and tests.
- New or existing test file: add valid/invalid execution-plan fixtures.

Do not edit approval, route, or goal execution behavior in Phase 1 unless the
change is test-only or dead-code-safe. The actual boundary switch should happen
as a coordinated Phase 2 through Phase 5 change.
