# OpenClaw Pilot Current Roadmap

Status: v0.2.11 safety hotfix in progress
Owner: Geumbi / Moonhwi Lee

## Current Release

- Current shipped release: v0.2.10
- Current target: v0.2.11
- Release theme: user-facing natural command safety

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

## Maintainer Artifact Commands

```bash
pilot artifact verify <evidence-packet.json>
pilot artifact conv <conv-request.json>
pilot artifact goal-request <goal-request.json>
```

These commands keep deterministic fixture, smoke, and CI checks available without
making JSON artifacts the default user experience.

## Next Work

- Add a real content-review evidence collector for explicit version, PR, tag, and
  run scopes.
- Add criteria-level long verification checkpoints and resume behavior.
- Improve `/conv` guidance so broad convergence requests can be converted into a
  clear `/goal` plan when no actionable finding exists.
