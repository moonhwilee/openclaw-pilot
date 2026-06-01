# OpenClaw Pilot Current Roadmap

Status: v0.2.12 implementation-review verify hotfix in progress
Owner: Geumbi / Moonhwi Lee

## Current Release

- Current shipped release: v0.2.11
- Current target: v0.2.12
- Release theme: broad implementation `/verify` creates scoped review plans

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

## Maintainer Artifact Commands

```bash
pilot artifact verify <evidence-packet.json>
pilot artifact conv <conv-request.json>
pilot artifact goal-request <goal-request.json>
```

These commands keep deterministic fixture, smoke, and CI checks available without
making JSON artifacts the default user experience.

## Next Work

- Run and evaluate the approved broad implementation verification plan with the
  real session runner.
- Add criteria-level long verification checkpoints and resume behavior.
- Improve `/conv` guidance so broad convergence requests can be converted into a
  clear `/goal` plan when no actionable finding exists.
