# Install OpenClaw Pilot

OpenClaw Pilot should feel like a normal CLI package. The default path is easy; diagnostics are available when needed.

## Quick Install

```bash
npm install -g openclaw-pilot
pilot init
pilot plan "Draft a document strategy plan"
```

Before npm publishing, install from a GitHub release tag:

```bash
npm install -g github:moonhwilee/openclaw-pilot#v0.1.0
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

`pilot smoke` runs the bundled plan, verify, conv, route, goal-draft, and live-adapter checks against temporary state.

## Gateway And Telegram

Gateway/Telegram routing should stay disabled until the local CLI path is working:

```bash
pilot init
pilot doctor
pilot smoke
```

Then enable exact commands in this order:

1. `/plan`
2. `/verify`
3. `/conv`
4. `/goal`

The package must not fall back to legacy Converge or GoalFlow behavior.
