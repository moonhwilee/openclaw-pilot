# OpenClaw Pilot Current Roadmap

Status: v0.3.0 command-mode planning implementation
Owner: Geumbi / Moonhwi Lee

## Current Release

- Current shipped release: v0.2.12
- Current target: v0.3.0
- Release theme: command-mode planning for natural user commands

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
