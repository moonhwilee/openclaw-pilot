# PilotLead v0.2.8 Product Contract

Status: implementation contract
Date: 2026-06-02
Scope: `/goal`, `/plan`, `/verify`, `/conv`, approval UX, and user-facing reports

This document is the product and implementation contract for the next Pilot
slice after the typed `execution-plan.json` authorization boundary. It does not
replace that boundary. It defines how Pilot should become a lead agent that
helps the user reach quality outcomes instead of foregrounding run metadata,
artifact paths, and receipts.

## Problem Statement

Pilot v0.2.7 has useful safety primitives:

- typed `execution-plan.json`;
- canonical plan hash;
- scoped approval;
- typed receipts;
- lineage and recovery artifacts;
- deterministic `/verify` and bounded `/conv` scaffolding.

Those primitives are necessary, but not sufficient. The user-facing product
still over-emphasizes status cards, file paths, run ids, receipts, and local
artifact existence. The next slice must make Pilot lead the user through goal
clarification, planning, execution, verification, convergence, and final
judgment.

## Non-Negotiable Boundaries

These rules continue to apply:

- No legacy authorization path.
- No fallback execution path.
- No request-prose execution.
- No execution from `approved_capabilities`, `preflight.typed_capabilities`, or
  old `approved-goal-request.json` artifacts.
- Approved execution must use the validated typed execution plan and its
  approved hash.
- Missing or mismatched execution plans fail closed before any runner starts.
- Out-of-plan work stops and reports the new decision point.
- User-facing reports must not imply semantic quality was verified when only
  deterministic structure checks were performed.

## Shared Lead Loop

Pilot should use one common lead loop with different command entry points and
stop points:

```text
intake -> context -> interview -> plan -> approve -> execute -> verify -> conv -> report
```

The command router should stay thin. It should select the command mode and hand
work to the shared lead behavior instead of implementing incompatible command
state machines.

## Phase-Gated Execution For Large Goals

Large work must not interpret "continue until the goal is done" as one broad
unbounded execution loop. PilotLead is responsible for the goal until completion,
but large implementations and refactors should move through bounded phases and
small executable slices.

Use this model:

```text
goal plan -> phase plan -> slice execute/check/conv -> slice execute/check/conv -> phase verify -> phase conv -> next phase -> final integration verify/conv -> report
```

Definitions:

- A `phase` is a strategic milestone in the goal.
- A `slice` is the concrete implementation unit. It should be small, testable,
  and reversible enough to converge without destabilizing the whole goal.
- A `slice check` is a lightweight gate such as focused tests, typecheck/build,
  local smoke, self-review, and delta-aware sanity checking.
- A `phase verify` is a semantic verification gate. When it uses `/verify`, it
  must follow the `/verify` rule requiring at least two specialized reviewers.
- Final integration verification/convergence checks whether the completed
  phases still satisfy the original goal together.

Implementation note: current Pilot code already uses lifecycle `phase` for
states such as `execute`, `verify`, `converge`, `reverify`, and `report`. Do not
reuse or overload that field for this product concept. Model large-goal
milestones with explicit names such as `goal_phase`, `milestone`, or
`phase_index`, and keep lifecycle phase separate.

Rules:

- Small clear goals may use a single loop.
- Medium goals should split into a few slices when dependency risk or rollback
  cost is non-trivial.
- Large refactors should be planned as phases and executed as slices inside
  those phases.
- Do not run full `/verify` after every slice. That would create unnecessary
  token and reviewer cost.
- Run full semantic verification at phase boundaries, final integration, and
  high-risk slices only.
- If a later phase materially differs from the approved plan, discovers a new
  high-risk action, or changes the rollback/risk profile, stop for a user
  decision instead of continuing under stale approval.

Issue priority gates:

- `P0`: stop immediately and fix. Examples: security boundary violation, data
  loss risk, execution impossible, approval-boundary violation, or core feature
  breakage.
- `P1`: phase cannot pass. Examples: main goal unmet, major regression, or large
  mismatch with user expectations.
- `P2`: fix within the current phase. Examples: important quality gap, omission,
  edge case, or maintainability risk.
- `P3`: report and may pass. Examples: minor improvement, low-priority polish,
  or future backlog.

Convergence rule:

- A slice may proceed after its lightweight checks pass and no known `P0`/`P1`
  issue exists.
- A phase is converged only when `P0`, `P1`, and `P2` issues for that phase are
  closed or explicitly reclassified.
- A phase may pass with `P3` issues if they are reported.
- Repeated, accumulating, or user-facing `P3` issues should be escalated to
  `P2`.
- The whole goal is complete only after every phase has converged and final
  integration has no blocking issue.

## Command Semantics

### `/goal <request>`

`/goal` is the full objective mode. The user is asking Pilot to lead the work
until a quality outcome is reached or a real decision/blocker appears.

Required behavior:

- Gather available context before asking questions.
- Run an `interview` phase when the goal needs clarification.
- Ask only the questions needed to make a good plan. The default range is 1-5
  questions, but complex work may ask more.
- Produce a user-readable plan with scope, non-goals, expected changes,
  success criteria, verification gates, risks, and stop conditions.
- For large work, include phase/slice boundaries, slice checks, phase verify
  gates, and the conditions that require stopping for user re-approval.
- Produce a typed execution plan as the only execution authority.
- Wait for explicit approval before execution.
- After approval, execute only the approved plan.
- Verify the result.
- Run convergence when important findings remain and the plan allows bounded
  correction.
- Report outcome, evidence, confidence, and residual risk before artifact paths.

Subagents are escalation tools, not a default ceremony. Use them when
complexity, risk, disagreement, or verification need justifies the cost.

### `/plan <request>`

`/plan` uses the same early engine as `/goal`, then stops after planning.

Required behavior:

- Run the same context and interview logic used by `/goal`.
- Produce a plan that a human can approve or revise.
- Do not execute.
- Do not create a separate planning quality path from `/goal`.

If the plan is execution-oriented, Pilot may show how to approve or convert it
into a `/goal` run, but standalone `/plan` remains planning-only.

### `approve <Run>` and Natural-Language Approval

`approve <Run>` remains the clearest auditable approval signal.

Natural-language approval such as "승인할게", "진행해", or "이 계획대로 해" is
allowed only when exactly one pending approval target is clear from the current
conversation/run context. If multiple targets are possible, Pilot must ask which
run is being approved.

Approval authorizes only the exact typed plan revision/hash shown to the user.

### `/verify <run|claim|artifact>`

`/verify` is a quality-verification command, not a deterministic packet checker
with a nicer label.

Required behavior:

- Use deterministic checks as supporting evidence, not the final semantic
  verdict.
- Verify goal fulfillment, quality, omissions, risks, user expectations,
  regression likelihood, and evidence sufficiency.
- Use at least two specialized subagents/reviewers for every `/verify` run.
  The user invokes `/verify` when they want serious independent verification;
  single-agent verification is too close to an ordinary chat request.
- Report a human-readable verdict:
  - `pass`
  - `pass_with_risks`
  - `needs_revision`
  - `fail`
  - `blocked`
- Include the main reasons, evidence checked, disagreements if any, confidence,
  and residual risk.

If the runtime cannot provide the required two specialized reviewers, `/verify`
must report that verification is blocked or incomplete. It must not silently
downgrade to single-agent verification while presenting a full verdict.

### `/conv <anchor|finding|request>`

`/conv` is convergence mode. It is not always a small `/goal`.

Clear convergence requests can start directly. Examples:

- "Check this document for errors, missing parts, and context problems."
- "Resolve the findings from this review."
- "Run another convergence round on this artifact."

Ambiguous or broad convergence requests must be promoted to lightweight
interview/planning first. Examples:

- "Improve this overall."
- "Fix anything that looks wrong."
- "Make this better" without a clear anchor or edit boundary.

`/conv` should use a delta-aware convergence frame, not a heavy finding ledger
state machine.

Each round should ask reviewers/agents to judge:

- Did the previously identified issue actually close?
- Did the current change introduce new problems?
- Are there newly discovered omissions or improvements?
- Is the whole context still coherent, not just the changed delta?
- What risk remains?
- Is another round needed?

Each round should write a short human-readable summary:

- target reviewed;
- prior issue resolution;
- new issues found;
- changes or improvements made;
- remaining risks;
- next action.

Termination is allowed when the final round has enough independent agreement
that:

- the prior important issue is resolved;
- no new blocking issue appeared;
- no important context omission remains;
- residual risks are acceptable and reported.

Do not require a separate `/verify` round after every `/conv`. A final
convergence round can serve as the cumulative checkpoint when it reviews both
prior findings and the latest delta. Add an independent `/verify` gate only for
high-risk work, material disagreement, low confidence, or explicit user request.

## Subagent Escalation Policy

Subagents are for independent judgment, not decoration.

Suggested default:

- small clear task: no subagent, unless command semantics require it;
- `/verify`: minimum two specialized reviewers;
- normal `/conv`: two reviewers when quality matters, fewer only for trivial
  low-risk checks;
- high-risk `/conv` or `/goal`: 3-5 reviewers;
- architecture/security/finance/contract/operations impact: 3-5 reviewers and
  explicit risk reporting.

PilotLead remains responsible for synthesis and final reporting. Subagent output
is evidence, not the final answer by itself.

## User Report Contract

User-facing output should be outcome-first:

1. What Pilot understood or decided.
2. What will happen or what happened.
3. Verdict, confidence, and residual risks.
4. Next action for the user.
5. Supporting artifacts, hashes, receipts, and paths.

Metadata remains necessary for recovery and audit, but it must not be the main
product surface for `/goal`, `/plan`, `/verify`, or `/conv`.

## Implementation Order

Recommended thin vertical slice:

1. Add user-facing product contract tests for `/plan` and `/goal` output:
   interview/context summary, plan body, verification gates, and approval
   guidance must appear before evidence paths.
2. Implement shared interview/context/planning behavior for `/plan` and `/goal`.
3. Update approval parsing to accept unambiguous natural-language approval while
   preserving exact plan hash approval.
4. Upgrade `/verify` semantics to require two specialized reviewers and return
   a semantic verdict distinct from deterministic packet checks.
5. Upgrade `/conv` to delta-aware round summaries and clear/broad request
   routing, without building a heavy ledger.
6. Add phase-gated planning for large `/goal` work: execute in small slices,
   use lightweight slice checks, and reserve full semantic verification for
   phase gates, high-risk slices, and final integration.
7. Keep recovery, receipts, lineage, and typed execution-plan approval intact.

## Acceptance Checks

The slice is not complete until these are true:

- `/plan` and `/goal` no longer present metadata cards as the primary output.
- `/plan` and `/goal` share the same context/interview/planning behavior.
- `/goal` execution still requires the approved typed execution plan.
- Natural-language approval works only for one unambiguous pending plan.
- Large `/goal` plans show phase/slice boundaries instead of one broad
  unbounded execution loop.
- Slice checks are lightweight and do not require full `/verify` unless the
  slice is high-risk.
- Phase gates cannot pass with unresolved `P0`, `P1`, or `P2` issues.
- `P3` issues may pass only when reported, and repeated/user-facing `P3` issues
  are escalated.
- `/verify` cannot claim full semantic verification without at least two
  specialized reviewers.
- Deterministic-only verification reports structural validity or incomplete
  verification, not full semantic sufficiency.
- `/conv` can run directly for clear anchored requests.
- `/conv` asks for interview/plan only for ambiguous or broad requests.
- `/conv` uses delta-aware judgment through round summaries, not a heavy ledger.
- No legacy approval artifact or fallback capability path becomes executable.

## Explicit Non-Goals

- Do not add new public commands for every phase.
- Do not require full `/verify` after every implementation slice.
- Do not build a generic agent job platform before the lead loop works.
- Do not add a heavy finding-ledger state machine for `/conv`.
- Do not make subagents mandatory for all commands.
- Do not let pretty Telegram formatting mask weak semantic conclusions.
