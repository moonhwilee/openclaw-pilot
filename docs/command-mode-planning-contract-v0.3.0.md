# Command-Mode Planning Contract v0.3.0

Status: Phase 0 design contract
Owner: Geumbi / Moonhwi Lee
Target release: v0.3.0
Date: 2026-06-02

This document replaces the broad "natural intent layer" proposal with a smaller
contract: user-facing commands already provide the top-level intent. Pilot should
use the command as a planning mode, then pass the natural-language request through
the existing plan and approval pipeline.

No runtime behavior changes are included in Phase 0.

## Problem

Pilot v0.2.11 correctly separated user-facing natural commands from maintainer
JSON artifact execution, but it treated broad natural `/verify` and `/conv`
requests as evidence or anchor problems instead of converting the request into a
mode-specific plan.

Pilot v0.2.12 fixed one representative `/verify` case with special version and
implementation-review keyword handling. That hotfix reduced one dead end, but it
placed semantic branching in the route layer. Growing that approach would create
legacy-like special cases and command-specific fallback behavior.

## Core Decision

Do not add a broad natural intent router.

Use explicit commands as planning modes:

- `/plan <natural request>` -> `mode = "plan"`
- `/goal <natural request>` -> `mode = "goal"`
- `/verify <natural request>` -> `mode = "verify"`
- `/conv <natural request>` -> `mode = "conv"`

The route layer should not decide that a natural request is an implementation
review, a release audit, a convergence task, or a goal by regex. The command
already gives Pilot the mode. The natural request should be interpreted inside
that mode by the planning pipeline.

## Architecture

### Thin Command Parser

The outer command parser only identifies the command:

- `/plan`
- `/goal`
- `/verify`
- `/conv`
- `approve`
- `status`
- `resume`
- `cancel`

It must not infer executable capability, review scope, implementation type, or
convergence strategy from request prose.

### Mechanical Target Resolver

`resolveUserCommandTarget()` remains useful and should stay mechanical:

- `empty`
- `artifact_like_disabled`
- `run_reference`
- `recent_alias`
- `natural_language`

It must not contain command-specific meaning. JSON-looking paths remain disabled
in the user route and are handled only by `pilot artifact ...` maintainer
commands.

### Command-Mode Planning Adapter

Add the smallest adapter needed to convert a natural user command into a planning
request:

```ts
type PlanMode = "plan" | "goal" | "verify" | "conv";

type CommandModePlanInput = {
  mode: PlanMode;
  request: string;
  anchor?: {
    kind: "run" | "recent";
    reference: string;
  };
};
```

The adapter may wrap the request with mode-specific context, but it must not
execute tools, collect evidence, run verification, run convergence, or approve
anything.

Examples:

- `/verify 0.2.8~0.2.12 구현 검증해줘` becomes a verification planning
  request. Version strings are request content, not route branch conditions.
- `/conv 이 설계대로 고쳐줘` becomes a convergence-mode plan that may recommend
  converting the work into a `/goal` execution plan. It must not run arbitrary
  edits from prose.
- `/goal 코드 수정해줘` becomes an approval-backed execution plan.

### Existing Plan Pipeline As The Shared Engine

Reuse and improve the existing pipeline:

- `runPlan()`
- `CommonPlanContract`
- `buildExecutionPlan()`
- `execution-plan.json`
- canonical execution-plan hash
- `approve <Run>`
- approved execution-plan validation

`buildPlan()` should become mode-aware, for example:

```ts
buildPlan({ mode, request, anchor });
```

This keeps the semantic work in planning, not routing. A future LLM planner can
replace or augment `buildPlan()` without changing command routing.

## Execution Authority

Natural prose is input to planning only. It is never execution authority.

Execution authority remains:

1. validated `execution-plan.json`;
2. canonical execution-plan hash;
3. explicit approval of that exact plan;
4. execution over approved `execution_plan.steps`.

This is the same boundary introduced by the execution-plan contract. Command-mode
planning must not create a second authorization model.

## Command Contracts

### `/plan`

Natural request creates a planning artifact only.

- No tool execution.
- No evidence collection.
- No runner.
- No external action.
- May produce a typed execution plan preview if useful, but execution still
  requires approval through the normal plan path.

### `/goal`

Natural request creates an execution-capable plan.

- Writes `execution-plan.json` only when the request is concrete enough.
- Stops for approval before execution.
- If underspecified, asks clarification instead of synthesizing broad authority.

### `/verify`

Natural request creates a verification-mode plan.

- It may describe evidence to collect, reviewers/checks to run, scope, criteria,
  and pass/fail/reporting expectations.
- It must not run evidence collection or review before approval.
- It must not silently attach to the newest run for broad prose.
- `recent` or run anchors can be used as explicit evidence anchors, but the
  result is still a verification plan or a clear clarification request.

### `/conv`

Natural request creates a convergence-mode plan.

- If a concrete finding/run anchor exists, the plan can prepare bounded
  convergence.
- If the request is actually new implementation work, the plan should recommend
  or create a goal-mode plan path.
- It must not silently bind to latest findings for broad prose.
- It must not execute edits from prose.

### `approve`, `status`, `resume`, `cancel`

These are not natural planning commands.

- `approve` requires an exact approved plan target.
- `status recent` may resolve because it is read-only.
- `resume recent` and `cancel recent` require exact target confirmation.
- No natural intent or command-mode adapter should run for these commands.

## Removal Targets

The v0.3.0 implementation must remove v0.2.12 route special cases:

- `versionScopesFromRequest()`
- `isImplementationReviewRequest()`
- `implementationReviewPlanRequest()`
- `verifyImplementationReviewPlanRoute()`

The implementation must also remove old natural-artifact shortcuts:

- `buildEvidencePacketFromRun()`
- `writeEvidencePacketForRun()`
- `writeConvRequestFromVerification()`

These helpers are not valid user-route fallbacks because they can turn natural
verification into deterministic artifact-existence checks or natural convergence
into implicit newest-run execution. If a future helper is needed, it must live
behind an approved typed execution plan or maintainer-only artifact command.

## No-Legacy / No-Fallback Gates

Implementation is not complete until these are true:

- No route branch classifies implementation-review intent by version regex or
  keyword regex.
- No user-facing natural command executes a JSON artifact shortcut.
- No user-facing natural command falls back to newest run execution or
  deterministic pass/fail judgment.
- Missing or ambiguous natural request context returns a plan or clarification,
  not hidden execution.
- `approve`, `resume`, and `cancel` do not accept broad recent aliases when they
  can mutate state.
- Approved execution still validates `execution-plan.json` and the stored hash
  before any runner or executor starts.
- There is no compatibility route that preserves the v0.2.12 special `/verify`
  behavior as a parallel path.

## Acceptance Matrix

| Input | Expected Result |
| --- | --- |
| `/plan 설계 정리해줘` | plan-mode artifact; no execution |
| `/goal 코드 수정해줘` | goal-mode execution plan; approval required |
| `/verify 0.2.8~0.2.12 구현 검증해줘` | verify-mode plan; no hardcoded version route |
| `/verify 최근 작업 문제 없는지 봐줘` | explicit recent anchor plus verify-mode plan or clarification; no deterministic-only approval |
| `/verify 문서의 주장 검증해줘` | verify-mode plan or clarification |
| `/conv 방금 finding 수렴해줘` | anchored conv plan when finding exists; otherwise needs anchor or goal-plan proposal |
| `/conv 이 설계대로 고쳐줘` | conv-mode plan that can redirect to goal-mode implementation; no prose execution |
| `/verify path/to/evidence.json` | `artifact_shortcut_disabled`; point to `pilot artifact verify` |
| `/conv path/to/conv-request.json` | `artifact_shortcut_disabled`; point to `pilot artifact conv` |
| `/goal path/to/goal-request.json` | `artifact_shortcut_disabled`; point to `pilot artifact goal-request` |
| `status recent` | allowed read-only recent resolution |
| `approve recent` | exact target required |
| `resume recent` | exact target required before `resume.json` |
| `cancel recent` | exact target required |

## Phase Plan

### Phase 1: Types And Adapter

- Add `PlanMode`.
- Add a minimal command-mode planning adapter.
- Extend `runPlan()` options to carry mode and optional anchor.
- Do not add a broad `NaturalCommandIntent` framework unless later code proves it
  necessary.

### Phase 2: Mode-Aware Planning

- Make `buildPlan()` mode-aware.
- Keep `CommonPlanContract` as the output contract.
- Keep `execution-plan.json` as the only executable authorization contract.

### Phase 3: Route Cleanup

- Replace natural `/verify`, `/conv`, `/goal`, and `/plan` branches with
  command-mode planning calls.
- Remove v0.2.12 special implementation-review route code.
- Keep `artifact_shortcut_disabled` behavior.

### Phase 4: Legacy/Fallback Removal

- Remove dead or demoted natural evidence-packet fallback helpers.
- Keep deterministic artifact engines only under `pilot artifact`.
- Update README and v0.2.11 contract docs so they no longer present v0.2.12's
  hardcoded implementation-review route as the desired model.

### Phase 5: Regression Gates

- Add acceptance tests for the full matrix above.
- Run build, tests, smoke, pack dry-run, and no-legacy grep gates.
- Do not release or restart Gateway without explicit approval after the diff is
  reviewed.

## Non-Goals

- Do not build a broad LLM intent router.
- Do not duplicate the approval or execution-plan model.
- Do not keep v0.2.12 version/keyword special cases as compatibility paths.
- Do not remove maintainer deterministic artifact commands.
- Do not execute unapproved natural prose.
- Do not add legacy backend fallback.
- Do not add fallback execution when target, evidence, plan, or approval is
  missing.

## Phase 0 Verdict

This plan is smaller than a standalone natural-intent layer and safer than
growing command-specific route heuristics.

It reuses the existing execution-plan contract, keeps command parsing thin, and
moves semantic work to the planning pipeline where it belongs. It also gives
v0.2.12 a clean exit: the hotfix behavior becomes a test case for verify-mode
planning, not a permanent router branch.
