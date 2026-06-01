# Natural Command Contract v0.2.10

Status: implementation-ready plan
Owner: Geumbi / Moonhwi Lee
Target release: v0.2.10

## Purpose

Pilot commands are user-facing product surfaces. A user should be able to type a
natural request such as `/verify 0.2.9 progress snapshot 개선 검증해줘` or
`/conv 최근 검증에서 나온 P2 문제 수렴해줘` without manually creating JSON
packets.

The existing JSON path forms stay supported, but they are advanced shortcuts for
maintainers, tests, fixtures, and internal artifacts. They should not be the
primary user-facing contract in Telegram or README examples.

## Product Principles

- Natural language is the default input shape for user-facing slash commands.
- JSON paths, artifact paths, and exact run ids are advanced shortcuts, not the
  primary UX.
- Natural language input may normalize into internal typed artifacts, but it
  must not become execution authority.
- Approved execution remains governed only by the typed `execution-plan.json`
  contract, its canonical hash, and explicit approval.
- No legacy backend fallback.
- No fallback execution when typed artifacts are missing or invalid.
- No request-prose execution.

## Command Classes

### Intent Commands

These commands should accept natural language as their primary user-facing
payload:

- `/plan <natural request>`
- `/goal <natural objective>`
- `/verify <natural claim, run target, or recent alias>`
- `/conv <natural finding, run target, or recent alias>`

Current status:

- `/plan` already follows this model.
- Telegram `/goal` already follows this model by creating a plan and waiting for
  approval.
- `/verify` needs the v0.2.10 fix.
- `/conv` needs the v0.2.10 fix.

Advanced shortcuts remain valid:

- `/verify <evidence-packet.json>`
- `/conv <conv-request.json>`

These shortcuts must be documented as maintainer/internal artifact routes. They
are not the main examples users should see.

### Management Commands

These commands operate on existing runs:

- `list`
- `status <Run>`
- `resume <Run>`
- `cancel <Run>`
- `approve <Run>`

Run ids remain a valid precise contract. The natural-language improvement here
is alias resolution, not broad intent execution:

- `status recent`, `status latest`, `status last`, and Korean equivalents such
  as `status 최근`, `status 마지막`, `status 방금` resolve to the newest run.
- `resume recent` may resolve a clear newest resumable run, then use the existing
  checkpoint rules.
- `cancel recent` must be conservative. If there is any ambiguity or risk, return
  a confirmation/needs-user-decision response instead of cancelling.
- `approve recent` must not silently approve. Approval should surface the exact
  plan/run and require explicit confirmation of that target.

## Architecture

Add a small shared command-target resolver at the route layer. This should be a
deterministic normalizer, not a large LLM intent router.

The resolver classifies command rest text into:

- `empty`
- `json_path_existing`
- `json_path_missing`
- `run_reference`
- `recent_alias`
- `natural_language`

Resolver responsibilities:

- Detect existing JSON artifact paths.
- Detect missing JSON-looking paths and return a user-facing usage problem, not
  a generic route failure.
- Resolve run references through the existing run/approval/lineage indexes.
- Resolve safe recent aliases through the same indexes.
- Pass natural language to command-specific request builders.
- Never invoke a legacy backend.
- Never execute work directly.

## /verify Flow

Primary user-facing forms:

- `/verify 0.2.9 progress snapshot 개선 검증해줘`
- `/verify 최근 goal 결과 검증해줘`
- `/verify 마지막 실행이 충분히 검증됐는지 봐줘`

Advanced shortcut:

- `/verify artifacts/pilot/evidence-packet.json`

Implementation:

1. Resolve the command target.
2. If target is `json_path_existing`, call the current `runVerify({ packetPath })`.
3. If target is `json_path_missing`, return a user-facing message explaining
   that JSON paths are advanced shortcuts and that natural language is supported.
4. If target is `run_reference` or `recent_alias`, build an internal evidence
   packet from lineage, receipts, artifacts, final reports, and existing
   verification/convergence records.
5. If target is `natural_language`, build a read-only evidence packet draft from
   the claim and any discoverable recent run/artifact context.
6. If evidence is insufficient, return `needs_user_decision` with the missing
   anchor or evidence requirement. Do not produce a generic failure.
7. Run the existing verify engine against the internal evidence packet.

Safety:

- Natural `/verify` is read-only.
- It may inspect local Pilot artifacts and lineage.
- It must not edit files, run external actions, approve plans, restart Gateway,
  deploy, merge, or create side effects outside its own verification artifacts.

## /conv Flow

Primary user-facing forms:

- `/conv 최근 검증에서 나온 P2 문제 수렴해줘`
- `/conv 마지막 goal의 remaining issue 정리해줘`
- `/conv 0.2.9 verify 결과 기준으로 수렴해줘`

Advanced shortcut:

- `/conv artifacts/pilot/conv-request.json`

Implementation:

1. Resolve the command target.
2. If target is `json_path_existing`, call the current `runConv({ requestPath })`.
3. If target is `json_path_missing`, return a user-facing message explaining
   that JSON paths are advanced shortcuts and that natural language is supported.
4. If target is `run_reference` or `recent_alias`, build an internal
   `conv-request.json` from that run's verification findings, lifecycle state,
   receipts, and anchor artifacts.
5. If target is `natural_language`, extract the requested finding or anchor from
   the text and attach it to the most relevant recent run only when unambiguous.
6. If the anchor is ambiguous, return `needs_user_decision`.
7. Run the existing bounded convergence engine against the internal conv request.

Safety:

- Natural `/conv` may only converge within a clear anchor.
- It must preserve P0-P3 gate behavior.
- It must not perform unrelated code edits or broad execution from prose.
- If the requested convergence requires implementation work outside the anchor,
  return a follow-up `/goal` plan recommendation instead of executing.

## Documentation Changes

Update user-facing docs so natural language is primary:

- README current scope and quick-start examples.
- `docs/install.md` command examples.
- Telegram/live route usage text.
- Missing-argument and missing-path help.

The documentation should still mention JSON path forms under an "Advanced
artifact shortcuts" section.

## Tests

Add tests around user-visible behavior:

- `/verify 자연어 요청` does not treat prose as a filesystem path.
- `/verify recent/latest/최근` resolves to internal evidence when possible.
- `/verify <missing-json-looking-path>` returns a helpful usage response.
- `/verify <existing-evidence-packet.json>` still works.
- `/conv 자연어 요청` does not treat prose as a filesystem path.
- `/conv recent/latest/최근` builds an internal conv request when possible.
- `/conv <missing-json-looking-path>` returns a helpful usage response.
- `/conv <existing-conv-request.json>` still works.
- `status recent/latest/최근` resolves the newest run.
- `cancel recent` and `approve recent` do not silently perform high-risk actions.
- Disabled commands remain unavailable and still report no legacy backend.
- `/goal` natural requests still stop at plan/approval before execution.

## Non-Goals

- Do not build a broad LLM intent router.
- Do not remove JSON path support.
- Do not make JSON paths the primary user-facing command shape.
- Do not auto-approve `approve recent`.
- Do not let `/conv` perform arbitrary code edits from prose.
- Do not add legacy compatibility routes.
- Do not add fallback execution.
- Do not add fake telemetry.

## Double-Check

Principle check:

- No legacy: pass. The resolver only normalizes targets for current commands and
  must not call removed or disabled backends.
- No fallback: pass. Missing typed artifacts become user-facing guidance or
  internal typed artifact generation, not fallback execution.
- No request-prose execution: pass. Natural text can produce evidence packets,
  conv requests, or plans, but approved execution remains tied to
  `execution-plan.json`.
- No overengineering: pass if implementation stays to one resolver plus small
  `/verify` and `/conv` request builders. A general LLM command router should be
  rejected for this release.
- UX correction: pass. JSON remains available but moves out of primary user
  examples.

## Implementation Order

1. Add `CommandTargetResolver` with deterministic classification and recent/run
   alias support.
2. Add user-facing route errors for missing JSON-looking paths.
3. Add internal evidence-packet builder for `/verify` run/recent/natural targets.
4. Add internal conv-request builder for `/conv` run/recent/natural targets.
5. Add `status recent/latest/최근` alias support.
6. Keep `cancel recent` and `approve recent` conservative.
7. Update README, install docs, and route usage text to natural-language-first.
8. Add Telegram-safe behavior tests and regression tests for advanced JSON
   shortcuts.
9. Run `npm test`, `npm run build`, `npm run smoke`, `npm pack --dry-run`, and
   `git diff --check`.

