# openclaw-pilot

OpenClaw Pilot is a local planning, verification, convergence, and scoped-goal CLI.

## Install

From npm, once published:

```bash
npm install -g openclaw-pilot
pilot init
pilot plan "Draft a document strategy plan"
```

From GitHub before npm publishing:

```bash
npm install -g github:moonhwilee/openclaw-pilot#v0.1.1
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
- `pilot goal <goal-request.json>` runs only scoped local goals with explicit approval and typed receipts.
- `pilot route --enabled|--disabled "<exact command>"` tests exact command routing without invoking any legacy backend.
- `pilot live --enabled=/plan,/verify "<exact command>"` applies per-command live enablement and renders Telegram-safe text.
- Plan artifacts: `goal.json`, `plan.md`, `events.jsonl`, and `final.md`.
- Verification artifacts: `verification.json`, `events.jsonl`, and `final.md`.
- Convergence artifacts: `conv.json`, `receipts.jsonl`, `events.jsonl`, `final.md`, and local round evidence updates.
- Goal artifacts: `goal-run.json`, `events.jsonl`, `final.md`, plus `receipts.jsonl` and local step artifacts only after scoped approval.
- Never executes shell tasks, mutates task files outside run artifacts, spawns agents, sends external messages, or routes Telegram commands.
- The route command is a local exact-command adapter only. It does not attach Telegram or Gateway routing yet.
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
PILOT_STATE_ROOT=/tmp/pilot-state npm run pilot -- route --enabled "/plan Draft a strategy"
PILOT_STATE_ROOT=/tmp/pilot-state npm run pilot -- live --enabled=/plan "/plan Draft a strategy"
```
