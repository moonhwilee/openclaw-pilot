# openclaw-pilot

OpenClaw Pilot is a local planning, verification, convergence, and scoped-goal CLI.

Current workspace roadmap and TODO are tracked in
`/Users/moon/.openclaw/workspace/docs/openclaw-pilot/current-roadmap.md`.

## Install

From npm, once published:

```bash
npm install -g openclaw-pilot
pilot init
pilot plan "Draft a document strategy plan"
```

From GitHub before npm publishing:

```bash
npm install -g --install-links github:moonhwilee/openclaw-pilot#v0.1.3
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
- `pilot smoke` runs a quick maintainer/CI health check over the shipped fixtures.
- `pilot plan <request>` creates local plan artifacts only.
- `pilot verify <evidence-packet.json>` evaluates a supplied evidence packet only.
- `pilot conv <conv-request.json>` reduces bounded findings around an anchor using local artifact updates only.
- `pilot goal <goal-request.json>` runs approved goals with typed receipts.
- `pilot list [limit]` lists recent Pilot runs from shared lineage without changing state.
- `pilot status <Run>` inspects one run's lifecycle, lineage, evidence, receipts, recovery freshness, and available artifacts without changing state.
- `pilot resume <Run>` writes `resume.json`, computes the latest safe phase checkpoint, and can automatically resume approved runner-backed work from `execute`, missing post-execution `verify`, fixable `converge`, missing post-convergence `reverify`, or standalone `/conv` from `conv-checkpoint.json` with a `resume-lock.json` idempotency guard.
- `pilot cancel <Run> [reason]` records a cancellation marker and blocks later approval/execution for that run.
- `pilot route --enabled|--disabled "<exact command>"` tests exact command routing without invoking any legacy backend.
- `pilot live --enabled=/plan,/verify "<exact command>"` applies per-command live enablement and renders Telegram-safe text.
- `approve <Run>` resolves a plan/run handle and, for supported approved goals, can continue into execution.
- Approved implementation/code/fix/test-like goals can use the minimal `run_codex_session` runner when `PILOT_SESSION_RUNNER_ENABLED=true`.
- Approved goal execution writes `post-execution-evidence.json` and automatically runs deterministic `/verify` against produced artifacts and typed receipts.
- If automatic post-execution verification returns fixable findings, approved goal execution can write `post-execution-conv-request.json`, run bounded local `/conv`, write `post-convergence-evidence.json`, and re-run deterministic `/verify`.
- Approved goal results include a lifecycle summary with user-visible statuses such as `completed_verified`, `completed_after_convergence`, `completed_with_risks`, `needs_user_decision`, and `blocked`, plus phase markers for execution, verification, convergence, re-verification, and reporting.
- Package API exports `runGatewayBridge()` from `openclaw-pilot/gateway` for a disabled-by-default OpenClaw Gateway bridge.
- Plan artifacts: `goal.json`, `plan.md`, `events.jsonl`, and `final.md`.
- Verification artifacts: `verification.json`, `events.jsonl`, and `final.md`.
- Convergence artifacts: `conv-request.json`, `conv-checkpoint.json`, `conv.json`, `receipts.jsonl`, `events.jsonl`, `final.md`, and local round evidence updates.
- Goal artifacts: `goal-run.json`, `events.jsonl`, `final.md`, plus `receipts.jsonl`, `post-execution-evidence.json`, optional post-execution convergence artifacts, verification artifacts, lifecycle status, recovery directives such as `resume.json`, `resume-lock.json`, `auto-resume-attempt.json`, and step/runner artifacts only after scoped approval.
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
npm run pilot -- verify fixtures/document_strategy/evidence-packet.json
npm run pilot -- conv fixtures/document_strategy/conv-request.json
npm run pilot -- goal fixtures/document_strategy/goal-request-draft.json
npm run pilot -- goal fixtures/document_strategy/goal-request-approved.json
npm run pilot -- list
npm run pilot -- status <Run>
npm run pilot -- resume <Run>
npm run pilot -- cancel <Run>
npm run pilot -- route --disabled "/plan Draft a document strategy plan"
npm run pilot -- route --enabled "/verify fixtures/research/evidence-packet.json"
npm run pilot -- live --enabled=/plan "/plan Draft a document strategy plan"
```

Override state root:

```bash
PILOT_STATE_ROOT=/tmp/pilot-state npm run pilot -- plan "Draft a strategy for ..."
PILOT_STATE_ROOT=/tmp/pilot-state npm run pilot -- verify fixtures/document_strategy/evidence-packet.json
PILOT_STATE_ROOT=/tmp/pilot-state npm run pilot -- conv fixtures/document_strategy/conv-request.json
PILOT_STATE_ROOT=/tmp/pilot-state npm run pilot -- goal fixtures/document_strategy/goal-request-approved.json
PILOT_STATE_ROOT=/tmp/pilot-state npm run pilot -- list 5
PILOT_STATE_ROOT=/tmp/pilot-state npm run pilot -- status <Run>
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

Standalone `/verify` remains rerunnable by evidence packet for now. The future checkpoint contract is opened as `pilot.verify_checkpoint.v0`: long verification can record processed criteria, processed evidence, written findings, and the next verification action before adding criteria-level resume execution.

Enable a session runner explicitly:

```bash
PILOT_SESSION_RUNNER_ENABLED=true \
PILOT_SESSION_RUNNER_COMMAND=codex \
PILOT_SESSION_RUNNER_ARGS_JSON='["exec","--ask-for-approval","never","--sandbox","workspace-write","-"]' \
npm run pilot -- goal path/to/approved-runner-goal.json
```
