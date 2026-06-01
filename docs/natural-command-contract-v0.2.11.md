# Natural Command Contract v0.2.11

Status: implemented safety contract
Owner: Geumbi / Moonhwi Lee
Target release: v0.2.11

v0.2.12 amendment: broad versioned implementation-review `/verify` requests do
not stop with generic evidence guidance. They create `verify_plan_created`, keep
the recognized version scope, and wait for approval before evidence collection
or runner-backed review.

## Purpose

Pilot user-facing commands must treat natural language as the default product
surface. JSON request and evidence packets are still useful deterministic
artifacts, but they are maintainer/internal inputs and must not look like the
normal Telegram or route UX.

This release fixes the unsafe impression that a broad natural `/verify` request
can pass just because recent run artifacts exist.

## Principles

- Natural language is the default input shape for user-facing slash commands.
- JSON artifacts are maintainer/internal inputs exposed through `pilot artifact`.
- Natural language can create plans, ask for evidence, or request bounded
  convergence, but it must not become execution authority.
- Approved execution remains governed by the typed execution plan, canonical
  hash, and explicit approval.
- No legacy backend fallback.
- No fallback execution when typed artifacts are missing or invalid.
- No request-prose execution.
- Do not present mechanical artifact checks as implementation-quality review.

## User Target Resolver

`runRoute()` uses a user-facing resolver with only these target kinds:

- `empty`
- `artifact_like_disabled`
- `run_reference`
- `recent_alias`
- `natural_language`

JSON-looking paths are deliberately classified as `artifact_like_disabled`.
They are not executed through the user route.

## Artifact Resolver

Maintainer artifact commands use a separate resolver:

- `json_path_existing`
- `json_path_missing`

Supported maintainer commands:

```bash
pilot artifact verify <evidence-packet.json>
pilot artifact conv <conv-request.json>
pilot artifact goal-request <goal-request.json>
```

These commands call the existing deterministic engines directly:

- `runVerify({ packetPath })`
- `runConv({ requestPath })`
- `runGoal({ requestPath })`

## /verify Contract

User-facing `/verify <text>` means content review, not mechanical artifact
existence checking.

Rules:

- Broad natural `/verify` must not silently bind to the newest run.
- `/verify recent` or `/verify <run>` must not report a deterministic-only
  artifact check as implementation-quality review.
- If the user asks for a broad implementation review with explicit versions,
  releases, updates, or implementation-principle language, create an
  approval-backed verification plan and return
  `user_report.status = "verify_plan_created"`.
- If review evidence/scope is still insufficient and cannot be converted into a
  concrete review plan, return `needs_user_decision` with
  `user_report.status = "verify_needs_evidence"`.
- If the user enters a JSON-looking path, return
  `user_report.status = "artifact_shortcut_disabled"` and point to
  `pilot artifact verify`.
- User output must not say `semantic not requested` or make `Findings: none`
  look like content review success.

## /conv Contract

User-facing `/conv <text>` means bounded convergence around a clear verification
finding or run anchor.

Rules:

- Broad natural `/conv` must not silently attach to the newest verification
  finding.
- If the anchor/finding is unclear, return `needs_user_decision` with
  `user_report.status = "conv_needs_anchor_or_plan"`.
- A concrete run/recent target can proceed only when actionable verification
  findings exist.
- If the user enters a JSON-looking path, return
  `user_report.status = "artifact_shortcut_disabled"` and point to
  `pilot artifact conv`.
- If the requested convergence is actually new implementation work, direct the
  user toward a `/goal` plan instead of executing prose.

## /goal Contract

User-facing `/goal <text>` remains plan-first:

- Natural objectives create a plan and stop for approval.
- Approved run references can execute through the existing approved plan flow.
- JSON goal request artifacts are no longer user-route shortcuts.
- JSON-looking paths return `artifact_shortcut_disabled` and point to
  `pilot artifact goal-request`.

## Recovery Contract

Recent aliases are allowed only when their risk matches the command:

- `status recent/latest/last/최근` is read-only and may resolve automatically.
- `resume recent/latest/last/최근` must require an exact run id before writing
  `resume.json` or attempting auto-resume.
- `approve recent` and `cancel recent` remain conservative and require exact
  target confirmation.

## Documentation

User-facing docs should show natural commands first:

- `/verify 최근 작업 문제 없는지 봐줘`
- `/conv <run> 검증 finding 수렴해줘`
- `/goal 목표 설명`

JSON examples belong only in maintainer/internal artifact sections.

## Tests

Required regression coverage:

- Broad versioned implementation `/verify` returns `verify_plan_created`, not
  generic `verify_needs_evidence` and not `sufficient_evidence`.
- Underspecified natural `/verify` returns `verify_needs_evidence`, not
  `sufficient_evidence`.
- Broad natural `/conv` returns `conv_needs_anchor_or_plan`, not a silent latest
  finding attachment.
- JSON-looking `/verify`, `/conv`, and `/goal` user-route inputs return
  `artifact_shortcut_disabled`.
- `pilot artifact verify`, `pilot artifact conv`, and
  `pilot artifact goal-request` still run the deterministic engines.
- `resume recent` stops before writing `resume.json`.
- `status recent` remains allowed.
- `approve recent` and `cancel recent` remain conservative.
- Disabled commands still report no legacy backend.

## Non-Goals

- Do not build a broad LLM intent router.
- Do not remove deterministic artifact engines.
- Do not keep JSON shortcuts in the user route.
- Do not auto-approve, auto-resume, or auto-cancel recent aliases.
- Do not let `/conv` perform arbitrary code edits from prose.
- Do not add legacy compatibility routes or fallback execution.

## Double-Check

- No legacy: pass. The route only normalizes current command targets.
- No fallback: pass. Missing/disabled artifact shortcuts stop with explicit
  guidance.
- No request-prose execution: pass. Natural `/goal` stops at plan approval;
  broad implementation `/verify` stops at a verification plan approval; generic
  natural `/verify` asks for evidence; natural `/conv` requires an anchor.
- User honesty: pass. Mechanical artifact verification is separated from content
  review.
