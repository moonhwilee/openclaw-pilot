# Install OpenClaw Pilot

OpenClaw Pilot should feel like a normal CLI package. The default path is easy; diagnostics are available when needed.

Current workspace roadmap and TODO live at
`/Users/moon/.openclaw/workspace/docs/openclaw-pilot/current-roadmap.md`.

## Quick Install

Install from the current GitHub release tag:

```bash
npm install -g --install-links github:moonhwilee/openclaw-pilot#v0.2.7
pilot init
pilot plan "Draft a document strategy plan"
```

After npm publishing, the install command will be:

```bash
npm install -g openclaw-pilot
pilot init
pilot plan "Draft a document strategy plan"
```

## Optional Checks

Use these only when validating an installation or debugging a user report:

```bash
pilot doctor
pilot smoke
```

`pilot doctor` checks Node, package metadata, local config, state directory access, and bundled fixtures.

`pilot smoke` runs the bundled plan, execution-plan contract, verify, conv, route, goal-draft, and live-adapter checks against temporary state. The execution-plan check reads the generated `execution-plan.json`, validates the schema, recomputes the canonical hash, and confirms the run id and typed steps.

## State And Lineage

`PILOT_STATE_ROOT` can override where artifacts are written. By default Pilot
stores state under the OpenClaw workspace state directory.

Plan runs write `execution-plan.json` next to the human-readable plan. Approval
and execution use that typed contract and hash; `plan.md` is user-facing
context, not the executable authorization source.

Each command writes its own artifacts and also appends a shared lineage record
to `lineage.jsonl` in the run directory and `index/lineage.jsonl` under the
state root. Use the lineage index when recovering or connecting `/plan`,
`/verify`, `/conv`, `/goal`, and `approve` across one workflow.

Recovery commands inspect that shared state and handle safe cancellation:

```bash
pilot list
pilot list 5
pilot status <Run>
pilot resume <Run>
pilot cancel <Run> "owner changed priority"
```

`pilot list` returns recent runs with short handles, status, artifact
directories, and resume hints. `pilot status <Run>` accepts a full run id or
unambiguous short handle and reports lifecycle status, lineage count, source
metadata, recovery freshness, evidence pointers, receipt pointers, and
available artifacts. `pilot resume <Run>` writes `resume.json`, computes the
latest safe phase checkpoint, and can auto-resume approved runner-backed work
from `execute`, missing post-execution `verify`, fixable `converge`, missing
post-convergence `reverify`, or standalone `/conv` from `conv-checkpoint.json`.
Auto-resume
creates `resume-lock.json` before execution and records the attempt in
`auto-resume-attempt.json` so repeated resume calls do not duplicate work. It
does not resume cancelled or terminal runs, and it does not blindly restart from
the beginning. `pilot cancel <Run>` writes `cancel.json`,
appends a cancellation lineage record, and blocks later `approve` or `/goal
<Run>` continuation for that run.

Standalone `/conv` writes `conv-request.json` and `conv-checkpoint.json`, so an
interrupted convergence run can continue from the next round. Standalone
`/verify` remains safely rerunnable from its evidence packet today; the
`pilot.verify_checkpoint.v0` contract is reserved for future long verification
that needs criteria/evidence-level resume.

Non-terminal, non-cancelled runs are considered stale after 30 minutes by
default. Set `PILOT_RECOVERY_STALE_AFTER_MS` to tune that window for local
tests or operational smoke checks.

## Session Runner

Approved implementation/code/fix/test-like goals can use the minimal
`run_codex_session` runner. The runner is disabled unless explicitly enabled:

```bash
PILOT_SESSION_RUNNER_ENABLED=true
PILOT_SESSION_RUNNER_COMMAND=codex
PILOT_SESSION_RUNNER_ARGS_JSON='["exec","--ask-for-approval","never","--sandbox","workspace-write","-"]'
PILOT_SESSION_RUNNER_TIMEOUT_MS=120000
```

The runner receives the approved Pilot task prompt on stdin. Pilot records the
prompt, stdout, stderr, runner result metadata, and a typed receipt. After a
successful approved execution, Pilot writes `post-execution-evidence.json` and
automatically runs deterministic `/verify` against the produced artifacts and
receipts. If verification returns fixable findings, Pilot can write
`post-execution-conv-request.json`, run bounded local `/conv`, write
`post-convergence-evidence.json`, and re-run deterministic `/verify`. If the
runner needs work outside the approved plan, it must stop and report that
boundary instead of silently expanding scope.

Approved execution requests are written as `approved-execution-request.json`
from the approved `execution-plan.json`. Pilot does not execute from request
prose, keyword inference, or legacy `approved-goal-request.json` artifacts.

Approved goal results also include a lifecycle summary. User-facing route and
Telegram text now distinguish terminal states such as `completed_verified`,
`completed_after_convergence`, `completed_with_risks`, `needs_user_decision`,
and `blocked`, and include a phase marker for the latest visible lifecycle
point.

## Gateway And Telegram

Gateway/Telegram routing should stay disabled until the local CLI path is working:

```bash
pilot init
pilot doctor
pilot smoke
```

The original staged rollout order was:

1. `/plan`
2. `/verify`
3. `/conv`
4. `/goal`

In the current workspace runtime, `/plan`, `/goal`, and `approve <Run>` have
already been live-smoked. Keep the live command list explicit and minimal for
the active environment.

The package must not fall back to legacy Converge or GoalFlow behavior.

Gateway integrations should import the thin bridge instead of shelling out:

```ts
import { runGatewayBridge } from "openclaw-pilot/gateway";

const result = await runGatewayBridge({
  message,
  gate: {
    liveRoutingEnabled: true,
    enabledCommands: ["/plan"],
    trustOpenClawSender: true,
    timeoutMs: 2500,
  },
});
```

Keep the Gateway live-routing config separate from `pilot.config.json`. Rollback should set `liveRoutingEnabled` to `false`; disabled commands return `unavailable` and explicitly do not invoke a legacy backend.
