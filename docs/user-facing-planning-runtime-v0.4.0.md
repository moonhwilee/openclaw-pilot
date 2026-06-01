# User-Facing Planning Runtime v0.4.0

Status: implementation plan
Owner: Geumbi / Moonhwi Lee
Date: 2026-06-02

## Problem

Pilot v0.3.0 correctly moved natural `/plan`, `/goal`, `/verify`, and `/conv`
requests into command-mode planning. It also kept the right execution boundary:
natural prose is only planning input, and approved `execution-plan.json` remains
the execution authority.

The remaining problem is user experience and phase clarity. A successful natural
command still reads too much like internal planning metadata:

- `CommonPlanContract` shape leaks into the user-facing response.
- Approval metadata appears before the user can understand the actual plan.
- Planning-only responses show empty `Evidence` sections even when no evidence
  could exist yet.
- `/goal`, `/verify`, `/conv`, and `/plan` need the same visible planning model,
  not separate command-specific formatter fixes.

The goal of this plan is to make Pilot's natural commands plannable,
approvable, and traceable in Telegram/Gateway without turning Pilot into a hard
security sandbox.

This document is intentionally phased, but the phases are implementation order,
not separate product scopes. Completing only the first phase is not success.
The v0.4.0 implementation is complete only when all phases in this document are
implemented, or when a later phase is explicitly rejected with evidence and the
remaining implementation still satisfies the product goal.

## Core Decision

Follow the Gajae-Code-style runtime boundary:

1. Understand the request.
2. Ask bounded clarification questions when the request is not concrete enough.
3. Present a user-facing draft.
4. Stop at pending approval only for execution-capable plans.
5. Execute only after approval validates the current execution-plan file and its
   canonical hash.
6. Report results and evidence only after execution or verification has produced
   evidence.

This is a phase/runtime improvement, not a new authorization system.

Execution authority remains exactly where v0.3.0 put it:

1. validated `execution-plan.json`;
2. canonical execution-plan hash;
3. explicit approval of that exact plan;
4. execution over approved `execution_plan.steps`.

## Scope

### v0.4.0 Scope

In scope for the full v0.4.0 implementation:

- User-facing draft presentation for natural `/plan`, `/goal`, `/verify`, and
  `/conv`.
- A shared renderer that turns the current `CommonPlanContract` into a
  `UserFacingPlanDraft` for user-visible output.
- Consistent pending-approval output for execution-capable natural command
  modes.
- Clarification output for underspecified natural requests.
- A planner-provider boundary for provider-backed planning when the current
  internal plan is not enough.
- Multi-turn interview continuation with exact run/interview binding.
- Continued use of `CommonPlanContract`, `execution-plan.json`, approval hash,
  run index, events, and lineage.
- Tests that prevent regression to internal metadata-first Telegram output.

### Delivery Phases

Phase 1: derived user-facing planning output.

- Derive `UserFacingPlanDraft` from the current run's `CommonPlanContract`.
- Render `/goal`, `/verify`, `/conv`, and `/plan` through one shared presenter.
- Remove or demote metadata-first legacy output.
- Preserve `execution-plan.json` plus canonical hash approval as the execution
  authority.

Phase 2: clarification quality.

- Ask bounded, useful clarification questions.
- Keep executable plan creation blocked while the request is still too vague.
- Do not introduce free-form continuation or implicit `recent/latest` binding.

Phase 3: provider-backed planning.

- Add `PlannerProvider` with a real production caller or an explicitly wired
  local orchestrator path.
- Let the provider produce better visible drafts or interview questions.
- Keep provider output presentation-facing only; it never becomes execution
  authority.

Phase 4: multi-turn interview runtime.

- Add exact run/interview id binding with `answer <Run> <clarification>`.
- Reject `answer recent`, `answer latest`, and other implicit newest-run binding.
- Enforce same-chat/sender checks where the original handoff recorded Telegram
  source metadata.
- Persist interview turns only after the exact binding contract is defined.
- Convert finalized interview context into the same `UserFacingPlanDraft` plus
  existing approval/hash flow.

The phase order exists to reduce risk while implementing. It is not permission
to stop early. The target v0.4.0 release should include all phases unless a
phase is intentionally rejected with evidence and the remaining implementation
still satisfies the product goal. Do not call v0.4.0 complete after Phase 1.

Out of scope for v0.4.0:

- Path-level `allowed_paths` enforcement.
- Tool-call interception.
- OS sandboxing.
- A broad natural intent router.
- A second approval or execution contract.
- A rewrite of maintainer artifact commands.
- Hard security-product work such as release approval policy changes, Gateway
  restart policy changes, or unrelated external-action governance.

## Overengineering Review

Keep these because they directly solve the problem:

- A user-facing draft shape. The current contract is good for machines but too
  mechanical for humans.
- A planner-provider interface. It gives Pilot a place to use 금비/OpenClaw
  orchestration without putting semantic work in the route layer.
- Clarification as a phase. Large goals can be legitimately underspecified, and
  forcing a plan too early creates fake confidence.
- Shared handling across `/goal`, `/verify`, `/conv`, and `/plan`. The same
  metadata-leak problem exists across the command-mode surface.

Remove or avoid these:

- A separate heavyweight `PlanningSessionState` store. First reuse existing run
  artifacts, events, status, and lineage. Add only the smallest phase field or
  interview artifact if the current lifecycle cannot represent the state.
- Multiple provider implementations. Add one real provider path first. Do not
  create unused disabled/no-op provider hooks.
- Strict schema for the visible draft. Validate enough to render safely, but do
  not create another machine authority beside `CommonPlanContract`.
- New evidence semantics. Planning output should not show evidence as if
  verification happened. Existing evidence packets stay for verify/goal results.
- Command-specific formatter branches. Use one presenter with mode labels and
  mode-specific copy.
- Hard permission gates. Keep current approval/hash/capability validation and
  leave path/tool enforcement out of v0.4.0.

## Legacy Cleanup Targets

The v0.4.0 implementation must remove or demote legacy behavior that became
unnecessary after the decision to treat Pilot as a user-facing planning runtime,
not a hard security sandbox.

Remove from user-facing planning output:

- internal `CommonPlanContract` vocabulary;
- raw `Command mode`, `Router`, and mechanical target details;
- raw phase/slice counts as the main plan explanation;
- `Evidence: none` sections for plan-created statuses;
- artifact-file lists as the lead explanation for planning success;
- approval/hash metadata before the user-facing plan summary.

Demote to structured debug/recovery data:

- generated artifact file paths;
- state root and artifact directory;
- execution-plan step counts;
- capability and risk details that are useful for approval but not the first
  explanation of the plan.

Keep because these are not legacy:

- `CommonPlanContract` as the internal planning contract;
- `execution-plan.json` as the executable authorization contract;
- canonical execution-plan hash;
- explicit `approve <Run>` validation;
- run index, events, lineage, and recovery artifacts.

Do not introduce:

- a second approval model based on `UserFacingPlanDraft`;
- a second planning state store that duplicates run artifacts/events/lineage;
- provider-side execution authority;
- path/tool hard enforcement in v0.4.0;
- command-specific user-facing presenters that drift apart.

Implementation must include snapshot or string tests for the removed
user-facing terms on these rendered surfaces:

- `runPilotCommand().reply_text`;
- Telegram adapter/live adapter text;
- Gateway bridge Telegram text where planning responses are bridged.

For plan-created statuses, these substrings must not appear in user-visible
planning text:

- `CommonPlanContract`;
- `Command mode`;
- `Router:`;
- `Phase/slice plan`;
- `Evidence\n- none`.

Generated artifact paths must not appear before the user-facing plan summary.
If a removed term remains in structured output for debugging or recovery, tests
should assert that it does not lead the Telegram planning response.

## Minimal Architecture

### Existing Internal Contract

Keep `CommonPlanContract` as the internal planning contract and keep
`execution-plan.json` as the executable authorization contract.

Do not rename or replace them in v0.4.0.

### User-Facing Draft

Add a small visible-plan view derived from the current internal plan:

```ts
type UserFacingPlanDraft = {
  title: string;
  mode: PlanMode;
  understood_request: string;
  assumptions: string[];
  approach: string[];
  steps: string[];
  verification: string[];
  approval_boundary: string[];
  not_doing_yet: string[];
  open_questions?: string[];
};
```

This type is presentation-facing. It is not execution authority.

For v0.4.0, the first path is deterministic derivation from the
`CommonPlanContract` created for the same run, command mode, request, and
mechanical anchor.

A derived draft is valid only when it is generated from the current run's
validated internal plan. It is not valid to create a polished draft from an
unrelated template, an older run, or a failed provider call.

If the internal plan cannot support a visible draft, Pilot should report
`plan_draft_unavailable` or ask for clarification. It must not fabricate a
polished plan from an unrelated fallback template.

### Planner Provider

Keep the interface narrow:

```ts
type PlannerProviderRequest = {
  mode: PlanMode;
  request: string;
  anchor?: CommandPlanAnchor;
  current_plan?: CommonPlanContract;
  prior_interview_turns?: InterviewTurn[];
};

type PlannerProviderResult =
  | { kind: "draft"; draft: UserFacingPlanDraft }
  | { kind: "interview"; questions: string[]; summary?: string }
  | { kind: "unavailable"; reason: string };
```

Provider responsibilities:

- ask planning-relevant questions;
- produce visible drafts;
- never execute;
- never approve;
- never collect evidence;
- never decide execution authority.

Route responsibilities remain thin:

- identify command mode;
- resolve target mechanically;
- call the planning path for natural requests;
- leave execution to approve/resume paths.

Provider availability must not block deterministic draft rendering when the
current internal plan is enough. Provider failure matters when Pilot selected
the provider path because the internal plan was not enough to answer or ask
well. In that case Pilot must return explicit unavailable/clarification output,
not a fake polished plan.

### Clarification And Interview

v0.4.0 should support clarification first, then exact-bound multi-turn
interview continuation.

Use existing `ambiguity_questions` and `*_needs_clarification` style statuses
where possible. A clarification turn should ask one to three questions and
should offer a proceed-with-assumptions path when reasonable.

Interview continuation requires exact binding semantics:

```ts
type InterviewTurn = {
  role: "planner" | "user";
  content: string;
  created_at: string;
};
```

Preferred storage:

- existing run artifact directory;
- `events.jsonl`;
- optional `interview.json` only if event replay is not enough.

Interview rules:

- one to three questions per Telegram turn;
- questions must affect plan quality, scope, success criteria, or approval
  boundary;
- no duplicate questions;
- if the user says to proceed, attempt draft creation with stated assumptions;
- long interviews should include a short running summary.

Continuation must bind to an exact run or interview id and, where available, the
same chat and sender. It must never silently attach free-form replies to
`recent`, `latest`, or the newest run. If exact binding cannot be established,
Pilot asks for the run/interview id instead of continuing.

Clarification/interview phase must not write an executable approval target until
the request is concrete enough to produce a plan.

### Presenter

Replace metadata-first output for planning statuses with this order:

1. Status
2. Understood Request
3. Plan
4. Verification / Checks
5. Approval Boundary
6. Not Doing Yet
7. Pending Approval, only when an approval-backed execution plan exists
8. Remaining / Next

Do not show an `Evidence` section for plan-created statuses. Evidence belongs to
completed execution, verification, or convergence reports.

For execution-capable modes (`/goal`, `/verify`, `/conv` when they produce an
approval-backed plan), keep approval details concise and secondary:

- short run id;
- approval command;
- short execution-plan hash;
- artifact directory only when useful for local debugging.

For `/plan`, do not show execution approval wording. `/plan` is planning-only.
If an internal `execution-plan.json` artifact is produced by the existing
pipeline, treat it as debug/recovery data unless the user converts the request
into an execution-capable command such as `/goal`.

Do not expose `CommonPlanContract` as a product concept in Telegram output.

## Command Behavior

### `/goal <natural request>`

Purpose: create an execution-capable goal plan.

Behavior:

- Ask interview questions if the objective, success criteria, scope, or risk is
  unclear.
- Show a user-facing draft when concrete enough.
- Create `execution-plan.json` only after the plan is concrete.
- Stop at pending approval.

### `/verify <natural request>`

Purpose: create a verification plan.

Behavior:

- Explain what will be verified, what evidence is needed, pass/fail criteria,
  and what will not be claimed yet.
- Do not collect evidence or run reviewers before approval.
- Preserve explicit run/recent anchors mechanically.
- Do not silently bind broad prose to the newest run.

### `/conv <natural request>`

Purpose: create a convergence or follow-up plan from context.

Behavior:

- Clarify whether the request is convergence on existing findings or new goal
  work.
- If it is new implementation work, present the goal-mode path rather than
  editing from prose.
- Do not execute convergence rounds before approval.

### `/plan <natural request>`

Purpose: create a planning-only draft.

Behavior:

- Use the same user-facing draft model.
- Do not imply execution will happen.
- Do not show an execution approval CTA.
- If `/plan recent` or `/plan <run>` is supported, treat it as read-only
  planning context or summary. It must not execute and must not restore disabled
  artifact shortcuts.

### Existing Non-Natural Paths

Do not change:

- maintainer `pilot artifact ...` commands;
- exact `approve`;
- exact `status`;
- exact `resume`;
- exact `cancel`;
- JSON-looking user-route artifact shortcuts disabled by v0.3.0. They remain
  maintainer-only through `pilot artifact verify|conv|goal-request ...`;
- run/recent anchors where already supported by the command contract.

Every planning-created user-visible response should use the new presenter,
regardless of target shape. Maintainer/debug structured output may remain
metadata-rich.

Do not restore broad deterministic execution or verdict paths from user-supplied
JSON-looking prose. Do not silently bind broad prose to `recent`, `latest`, or
the newest run.

## Implementation Steps

### 1. Add Derived User-Facing Draft Types And Renderer

- Add `UserFacingPlanDraft`.
- Add a pure renderer that converts a draft plus approval preview into Telegram
  text sections.
- Add a derivation helper from the current run's `CommonPlanContract`.
- Keep provider result types separate from execution authority.

### 2. Replace Planning Presenter Output

- Update `plan_created`, `goal_plan_created`, `verify_plan_created`, and
  `conv_plan_created` presentation.
- Remove plan-created `Evidence: none` from Telegram/live output.
- Keep artifact pointers available in structured route output, not as the lead
  user message.

### 3. Preserve Existing Approval Flow

- Continue writing `execution-plan.json` for concrete approval-backed plans.
- Continue computing the canonical hash.
- At approval and execution boundaries, recompute the canonical hash from the
  current `execution-plan.json` file and compare it to the stored approved hash.
- Do not add a second approval model.

### 4. Add Clarification Handling

- Add `*_needs_clarification` output using the same presenter family.
- Ask one to three actionable questions per turn.
- Offer proceed-with-assumptions when reasonable.
- Keep execution-plan creation blocked while interviewing.

### 5. Add Planner Provider

- Add the narrow provider interface.
- Wire exactly one real caller or local orchestrator path.
- On unavailable provider in provider-selected mode, return explicit
  unavailable/clarification output instead of falling back to a fake plan.
- Keep provider output presentation-facing only.

### 6. Add Multi-Turn Interview

- Add interview turn persistence with exact run/interview id binding.
- Use `answer <Run> <clarification>` as the explicit continuation command.
- Continuation must require exact binding and same chat/sender where available.
- Never attach free-form answers to `recent`, `latest`, or newest run.
- Finalizing an interview must produce the same `UserFacingPlanDraft` and, for
  execution-capable plans, the same `execution-plan.json` plus approval/hash
  boundary.

### 7. Tests

Required coverage:

- `/goal natural` shows a user-facing plan before approval.
- `/verify natural` shows a verification plan, not empty evidence.
- `/conv natural` shows convergence/follow-up planning, not implicit execution.
- `/plan natural` uses the same presenter shape and remains planning-only.
- `/plan natural` does not show an execution approval CTA.
- plan-created statuses do not render `Evidence: none`.
- plan-created user-visible output does not render `CommonPlanContract`,
  `Command mode`, `Router:`, or `Phase/slice plan`.
- generated artifact paths do not appear before the plan summary.
- clarification phase does not create executable authority.
- approval recomputes and validates the current `execution-plan.json` canonical
  hash before execution.
- JSON-looking user-route artifact shortcuts remain disabled and maintainer-only
  through `pilot artifact ...`.
- run/recent anchors remain mechanical only where already supported.
- provider unavailable does not create a fake plan when provider-selected mode is
  used.
- multi-turn interview continuation requires exact run/interview binding and
  rejects implicit `recent/latest` continuation.

## Completion Criteria

The v0.4.0 implementation is complete when:

- `/goal`, `/verify`, `/conv`, and `/plan` natural requests share one
  user-facing planning presenter.
- Internal metadata no longer leads Telegram planning responses.
- Approval output is still present but secondary to the plan.
- `/plan` stays planning-only and does not show execution approval wording.
- Planning output does not claim evidence before evidence exists.
- No route-layer semantic regex or new natural intent router is introduced.
- No new hard sandbox or path-level permission system is introduced.
- Existing approval/hash tests still pass.
- A real provider-backed planning path exists or is explicitly rejected with
  evidence that deterministic planning plus clarification satisfies the product
  goal.
- Multi-turn interview continuation exists with exact binding, or is explicitly
  rejected with evidence and replaced by an equivalent bounded clarification
  flow that still satisfies the product goal.

## Design Guardrails

- Router stays thin.
- Target resolver stays mechanical.
- Planner asks or plans; it does not execute.
- Natural prose never becomes execution authority.
- User-facing draft never replaces `execution-plan.json`.
- Do not fake plans on provider failure or missing derivation data.
- Do not split `/goal`, `/verify`, `/conv`, and `/plan` into four unrelated UX
  systems.
- Keep hard enforcement out until a separate, evidence-backed need appears.

## Summary

This is not a `/goal` formatter patch. It is a planning-runtime correction for
all natural Pilot commands and is versioned as v0.4.0 because it changes the
product concept from metadata-shaped command planning to user-facing
planning/interview/approval runtime.

Pilot should trust the LLM enough to plan and interview, but keep phase
boundaries clear enough that Telegram/Gateway execution remains explainable:
understand first, plan visibly, wait for approval, execute only through the
existing hash-validated plan.
