# OpenClaw Pilot Current Roadmap

Status: v0.4.1 shipped; Workbench alignment next
Owner: Geumbi / Moonhwi Lee

## Current Release

- Current shipped release: v0.4.1
- Current target: team-leader-controlled Pilot alignment for OpenClaw
  Multi-Agent Workbench
- Release theme: complete the v0.4.0 planning-runtime document goal by adding
  provider-backed planning and durable exact-bound interview context.

## Naming And Semantics

The product and package name remains `Pilot`.

For Workbench alignment, Pilot must be treated as a feature used by the owning
OpenClaw agent main session, not as an actor. Pilot must not own a Work Unit,
lead a team, or spawn a hidden orchestrator agent. The owning agent main session
remains the team leader and directly coordinates its own subagents through
Pilot's control, evidence, and recovery surfaces.

## Workbench Acceptance Fixture

Before the Workbench alignment refactor, the acceptance fixture must define the
shape of a team-leader-controlled Work Unit without changing runtime behavior.
The fixture lives under `fixtures/workbench/team-leader-controlled/` and covers:

- a positive Work Unit with `owner_main_session_ref`,
  `pilot_control_mode=team-leader-controlled`, and
  `subagent_orchestration_mode=direct-main-session`;
- an Internal Context Packet that carries the same Work Unit and owner main
  session refs;
- an expected Pilot artifact that records control, evidence, recovery, lineage,
  registry, and direct subagent task refs without becoming an actor;
- a negative hidden-orchestrator artifact that must fail the fixture contract.

The fixture is the pre-refactor contract. Runtime changes must later satisfy it
without introducing a hidden orchestrator agent.

## v0.4.1 Correction Scope

v0.4.0 shipped the shared user-facing presenter and `PlannerProvider` boundary,
but it still used local deterministic derivation for the visible plan. v0.4.1
closes that document-goal gap:

- Provider-backed planning receives raw request, command mode, source/run
  context envelope, mechanical anchor, current internal plan, execution plan,
  and prior interview turns.
- `PILOT_PLANNER_PROVIDER=orchestrator` selects the OpenClaw/orchestrator
  provider path. `PILOT_PLANNER_PROVIDER_COMMAND` can provide a local command
  adapter; otherwise Pilot calls `openclaw agent --local --json` with a
  planning-only contract.
- Provider output is presentation-facing only: drafts or bounded interview
  questions. It never approves, executes, collects evidence, or replaces the
  typed execution plan.
- Provider failure is fail-closed with `*_planner_unavailable`; Pilot must not
  silently fall back to a polished local fake plan when provider mode is
  selected.
- `answer <Run> <clarification>` persists exact-bound interview turns and
  forwards them to the provider. `answer recent/latest` remains rejected, and
  same-chat/sender checks remain enforced where source metadata exists.
- Execution authority remains the typed `execution-plan.json` canonical hash
  plus explicit approval.

## v0.2.11 Scope

- User-facing `/verify`, `/conv`, and `/goal` route input is natural by default.
- JSON request/evidence artifacts move out of the user route into
  `pilot artifact`.
- Broad natural `/verify` no longer silently binds to the newest run or reports
  a deterministic artifact check as content review.
- Broad natural `/conv` no longer silently binds to the newest verification
  finding.
- `resume recent/latest/last/최근` requires an exact run id before writing
  `resume.json`.
- User-facing progress output avoids `semantic` wording and distinguishes content
  review from mechanical artifact checks.

## v0.2.12 Scope

- Broad implementation-review `/verify` requests with explicit versions,
  releases, or implementation-principle language create `verify_plan_created`.
- The generated plan preserves the version scope and stops for explicit approval
  before evidence collection or runner-backed review.
- Telegram/live handoff records the generated verification plan so
  `approve <Run>` can resolve it.
- Generic underspecified `/verify` still returns `verify_needs_evidence`; JSON
  artifact execution remains maintainer-only through `pilot artifact`.

## v0.3.0 Target

Source of truth: `docs/command-mode-planning-contract-v0.3.0.md`.

- Treat `/plan`, `/goal`, `/verify`, and `/conv` as explicit planning modes.
- Keep the command parser thin and the target resolver mechanical.
- Route natural requests through mode-aware planning, not command-specific
  keyword or version regex branches.
- Reuse `CommonPlanContract`, `execution-plan.json`, canonical plan hashes, and
  explicit approval as the execution boundary.
- Remove the v0.2.12 implementation-review special route after replacing it with
  verify-mode planning coverage.
- Keep JSON artifacts maintainer-only through `pilot artifact`.

## v0.3.0 Implementation Status

- `PlanMode = plan | goal | verify | conv` is added.
- `runPlan()` carries mode and optional mechanical anchor into plan generation,
  execution-plan inputs, events, and lineage.
- Natural `/plan`, `/goal`, `/verify`, and `/conv` routes now create
  command-mode plans.
- `/verify` no longer has version or implementation-keyword route branches.
- `/conv` no longer writes `natural-conv-request.json` or runs convergence from
  broad user prose.
- Old natural evidence-packet and natural conv request helpers were removed from
  the user route code path.

## Maintainer Artifact Commands

```bash
pilot artifact verify <evidence-packet.json>
pilot artifact conv <conv-request.json>
pilot artifact goal-request <goal-request.json>
```

These commands keep deterministic fixture, smoke, and CI checks available without
making JSON artifacts the default user experience.

## Verification Gates

- Build must pass.
- Full test suite must pass.
- Smoke and pack dry-run must pass.
- Grep gates must show no v0.2.12 special route functions or old natural
  artifact fallback helpers in `src/`.
- Live smoke must show `/verify 계획문서를 검증해보자` returns
  `verify_plan_created`, not `verify_needs_evidence`.
- Gateway restart still requires preflight before applying the installed build.
