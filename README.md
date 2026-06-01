# openclaw-pilot

OpenClaw Pilot is a local planning, verification, convergence, and scoped-goal CLI.

Current roadmap and TODO are tracked in
`docs/openclaw-pilot/current-roadmap.md`.

The next PilotLead UX and quality-loop implementation contract is documented
in `docs/pilotlead-v0.2.8-product-contract.md`.

The current natural-command UX contract is documented in
`docs/natural-command-contract-v0.2.11.md`: user-facing commands are
natural-language-first, while JSON artifact execution is maintainer-only through
`pilot artifact`.

## Install

From the current GitHub release:

```bash
npm install -g --install-links github:moonhwilee/openclaw-pilot#v0.2.11
pilot init
pilot plan "Draft a document strategy plan"
```

After the package is published to npm, the install command will be:

```bash
npm install -g openclaw-pilot
pilot init
pilot plan "Draft a document strategy plan"
```

If something looks off:

```bash
pilot doctor
pilot smoke
```

`doctor` and `smoke` are optional diagnostics. Normal users should not need to understand release manifests, fixture hashes, or strict parity checks.

Current scope:

- `pilot init` creates a minimal `pilot.config.json` and default state directories.
- `pilot doctor` reports package/config/state health in a user-friendly way.
- `pilot smoke` runs a quick maintainer/CI health check over the shipped fixtures, including the typed `execution-plan.json` contract/hash check.
- `pilot plan <request>` creates local plan artifacts only.
- `pilot verify <natural target>` treats verification as content review by default and refuses to present mechanical artifact checks as implementation approval.
- `pilot conv <natural target>` converges clear findings from a recent run, run reference, or supplied anchor, and asks for a clearer anchor or plan when prose is broad.
- `pilot goal <natural objective>` creates a goal-intake plan and waits for approval before execution.
- `pilot artifact verify <evidence-packet.json>` runs maintainer-only mechanical evidence packet verification.
- `pilot artifact conv <conv-request.json>` runs maintainer-only bounded convergence from a typed conv request.
- `pilot artifact goal-request <goal-request.json>` runs maintainer-only typed goal request fixtures.
- `pilot list [limit]` lists recent Pilot runs from shared lineage without changing state.
- `pilot status <Run>` inspects one run's lifecycle, lineage, evidence, receipts, recovery freshness, and available artifacts without changing state.
- `pilot resume <Run>` writes `resume.json`, computes the latest safe phase checkpoint, and can automatically resume approved runner-backed work from `execute`, missing post-execution `verify`, fixable `converge`, missing post-convergence `reverify`, or standalone `/conv` from `conv-checkpoint.json` with a `resume-lock.json` idempotency guard. `resume recent/latest` is not executed silently because resume can create artifacts and run checkpoints.
- `pilot cancel <Run> [reason]` records a cancellation marker and blocks later approval/execution for that run.
- `pilot route --enabled|--disabled "<exact command>"` tests exact command routing without invoking any legacy backend.
- `pilot live --enabled=/plan,/verify "<exact command>"` applies per-command live enablement and renders Telegram-safe text.
- `approve <Run>` resolves a plan/run handle and, for supported approved goals, can continue into execution.
- Approved implementation/code/fix/test-like goals can use the minimal `run_codex_session` runner when `PILOT_SESSION_RUNNER_ENABLED=true`.
- Approved goal execution writes `post-execution-evidence.json` and automatically runs deterministic `/verify` against produced artifacts and typed receipts.
- If automatic post-execution verification returns fixable findings, approved goal execution can write `post-execution-conv-request.json`, run bounded local `/conv`, write `post-convergence-evidence.json`, and re-run deterministic `/verify`.
- Approved goal results include a lifecycle summary with user-visible statuses such as `completed_verified`, `completed_after_convergence`, `completed_with_risks`, `needs_user_decision`, and `blocked`, plus phase markers for execution, verification, convergence, re-verification, and reporting.
- Route, live, and Telegram-safe replies include a compact Progress section when useful. The snapshot surfaces goal milestone/phase, lifecycle phase, convergence rounds, semantic reviewer counts, P0-P3 finding counts, and the next action without requiring users to open raw artifacts first.
- Package API exports `runGatewayBridge()` from `openclaw-pilot/gateway` for a disabled-by-default OpenClaw Gateway bridge.
- Plan artifacts: `goal.json`, `plan.md`, `execution-plan.json`, `events.jsonl`, and `final.md`. The human-readable plan is not the execution authority; approved execution uses the typed execution plan contract.
- Verification artifacts: `verification.json`, `events.jsonl`, and `final.md`.
- Convergence artifacts: `conv-request.json`, `conv-checkpoint.json`, `conv.json`, `receipts.jsonl`, `events.jsonl`, `final.md`, and local round evidence updates.
- Goal artifacts: `goal-run.json`, `events.jsonl`, `final.md`, plus `receipts.jsonl`, `post-execution-evidence.json`, optional post-execution convergence artifacts, verification artifacts, lifecycle status, recovery directives such as `resume.json`, `resume-lock.json`, `auto-resume-attempt.json`, and step/runner artifacts only after scoped approval.
- Approval artifacts use `approved-execution-request.json`, mechanically derived from the hash-validated `execution-plan.json`. Pilot does not execute from request prose, inferred keywords, or legacy `approved-goal-request.json` artifacts.
- Shared lineage artifacts: each run appends `lineage.jsonl` in its artifact directory and `index/lineage.jsonl` in the state root so `/plan`, `/verify`, `/conv`, `/goal`, approval, and recovery records can be recovered with one common model.
- By default the session runner is disabled. When enabled, it executes only the configured runner command under the approved plan and captures stdout/stderr/result artifacts.
- Never sends external messages or owns Gateway lifecycle. Out-of-plan work must stop and be reported.
- The route/live commands are local adapters. `runGatewayBridge()` is an importable bridge for Gateway wiring, but the package does not restart or modify OpenClaw Gateway.
- Deterministic code checks schema, artifact existence, references, and explicit scope flags. It does not judge semantic quality by regex or hidden context.
- Shipped profiles are `document_strategy` and `research`. Profiles set vocabulary, evidence expectations, and risk defaults only; core lifecycle behavior stays unchanged.
- Installation and package usage details are in `docs/install.md`.

Run:

```bash
npm run pilot -- init
npm run pilot -- doctor
npm run pilot -- smoke
npm run pilot -- plan "Draft a strategy for ..."
npm run pilot -- verify "최근 goal 결과가 충분히 검증됐는지 봐줘"
npm run pilot -- conv "최근 검증에서 나온 P2 문제 수렴해줘"
npm run pilot -- goal "Create a tiny local smoke artifact and verify it"
npm run pilot -- list
npm run pilot -- status recent
npm run pilot -- resume <Run>
npm run pilot -- cancel <Run>
npm run pilot -- route --disabled "/plan Draft a document strategy plan"
npm run pilot -- route --enabled "/verify 최근 goal 결과 검증해줘"
npm run pilot -- live --enabled=/plan "/plan Draft a document strategy plan"
```

Maintainer artifact commands for fixtures and typed internal artifacts:

```bash
npm run pilot -- artifact verify fixtures/document_strategy/evidence-packet.json
npm run pilot -- artifact conv fixtures/document_strategy/conv-request.json
npm run pilot -- artifact goal-request fixtures/document_strategy/goal-request-draft.json
npm run pilot -- artifact goal-request fixtures/document_strategy/goal-request-approved.json
```

Override state root:

```bash
PILOT_STATE_ROOT=/tmp/pilot-state npm run pilot -- plan "Draft a strategy for ..."
PILOT_STATE_ROOT=/tmp/pilot-state npm run pilot -- verify "최근 실행 결과 검증해줘"
PILOT_STATE_ROOT=/tmp/pilot-state npm run pilot -- conv "최근 검증 finding 수렴해줘"
PILOT_STATE_ROOT=/tmp/pilot-state npm run pilot -- goal "Draft and verify a local strategy artifact"
PILOT_STATE_ROOT=/tmp/pilot-state npm run pilot -- list 5
PILOT_STATE_ROOT=/tmp/pilot-state npm run pilot -- status recent
PILOT_STATE_ROOT=/tmp/pilot-state npm run pilot -- resume <Run>
PILOT_STATE_ROOT=/tmp/pilot-state npm run pilot -- cancel <Run> "owner changed priority"
PILOT_STATE_ROOT=/tmp/pilot-state npm run pilot -- route --enabled "/plan Draft a strategy"
PILOT_STATE_ROOT=/tmp/pilot-state npm run pilot -- live --enabled=/plan "/plan Draft a strategy"
```

Recovery freshness:

```bash
PILOT_RECOVERY_STALE_AFTER_MS=1800000 npm run pilot -- status <Run>
```

`PILOT_RECOVERY_STALE_AFTER_MS` controls when a non-terminal, non-cancelled run is shown as stale in `list`, `status`, and `resume` output. The default is 30 minutes. Stale status does not mean "rerun from the beginning"; `resume <Run>` uses the latest safe checkpoint. The current v1 slice can auto-resume approved runner-backed work from `execute`, restart a missing post-execution `verify`, run bounded `converge` for fixable verification findings, restart a missing post-convergence `reverify`, and continue standalone `/conv` from `conv-checkpoint.json`.

Standalone user-facing `/verify` means content review. If the route does not have enough evidence scope to review the actual implementation or outcome, it returns `verify_needs_evidence` instead of silently creating a deterministic-only packet. Mechanical evidence packet verification remains available through `pilot artifact verify`. The future checkpoint contract is opened as `pilot.verify_checkpoint.v0`: long verification can record processed criteria, processed evidence, written findings, and the next verification action before adding criteria-level resume execution.

Enable a session runner explicitly:

```bash
PILOT_SESSION_RUNNER_ENABLED=true \
PILOT_SESSION_RUNNER_COMMAND=codex \
PILOT_SESSION_RUNNER_ARGS_JSON='["exec","--ask-for-approval","never","--sandbox","workspace-write","-"]' \
npm run pilot -- artifact goal-request path/to/approved-runner-goal.json
```
