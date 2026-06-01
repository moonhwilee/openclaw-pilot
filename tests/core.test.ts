import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runPilotCommand } from "../src/core/run.ts";

async function tempStateRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pilot-core-state-"));
}

test("core API routes enabled plan commands through Pilot", async () => {
  const previousStateRoot = process.env.PILOT_STATE_ROOT;
  process.env.PILOT_STATE_ROOT = await tempStateRoot();
  try {
    const result = await runPilotCommand({
      input: "/plan Draft a local document strategy plan.",
      enabledCommands: ["/plan"],
      metadata: { message_id: "core-test" },
    });

    assert.equal(result.schema_version, "pilot.command_result.v0");
    assert.equal(result.status, "routed");
    assert.equal(result.enabled, true);
    assert.equal(result.command, "/plan");
    assert.equal(result.backend, "openclaw-pilot");
    assert.equal(result.route?.status, "routed");
    assert.match(result.reply_text, /Status: plan_created/);
    assert.match(result.reply_text, /Run: \d{6}/);
    assert.match(result.reply_text, /Run ID: \d{8}T\d{6}Z-draft-a-local-document-strategy-plan/);
    assert.match(result.reply_text, /Next: Review the plan. To continue, reply "approve /);
    assert.deepEqual(result.metadata, { message_id: "core-test" });
  } finally {
    if (previousStateRoot === undefined) {
      delete process.env.PILOT_STATE_ROOT;
    } else {
      process.env.PILOT_STATE_ROOT = previousStateRoot;
    }
  }
});

test("core API keeps disabled exact commands unavailable without fallback", async () => {
  const result = await runPilotCommand({
    input: "/verify fixtures/document_strategy/evidence-packet.json",
    enabledCommands: ["/plan"],
  });

  assert.equal(result.status, "unavailable");
  assert.equal(result.enabled, false);
  assert.equal(result.command, "/verify");
  assert.equal(result.route?.status, "unavailable");
  assert.match(result.route?.fallback_message || "", /No legacy backend/);
  assert.match(result.reply_text, /Status: unavailable/);
  assert.match(result.reply_text, /No legacy backend/);
});

test("core API returns safe unsupported result without legacy fallback", async () => {
  const result = await runPilotCommand({
    input: "/oldgoal do something",
    enabledCommands: ["/goal"],
  });

  assert.equal(result.status, "unsupported");
  assert.equal(result.enabled, false);
  assert.equal(result.command, "/oldgoal");
  assert.equal(result.route, undefined);
  assert.equal(result.error_code, "unsupported_exact_command");
  assert.match(result.reply_text, /Unsupported Pilot exact command/);
  assert.match(result.recovery_hint || "", /\/plan, \/verify, \/conv, \/goal/);
});

test("core API returns safe failed result without exposing thrown error details", async () => {
  const result = await runPilotCommand({
    input: "/verify /tmp/pilot-core-missing-evidence-packet.json",
    enabledCommands: ["/verify"],
  });

  assert.equal(result.status, "failed");
  assert.equal(result.enabled, false);
  assert.equal(result.command, "/verify");
  assert.equal(result.route, undefined);
  assert.equal(result.error_code, "pilot_command_failed");
  assert.match(result.reply_text, /Pilot command failed/);
  assert.doesNotMatch(result.reply_text, /ENOENT/);
  assert.doesNotMatch(result.reply_text, /pilot-core-missing-evidence-packet/);
  assert.doesNotMatch(result.reply_text, /\/tmp\//);
});
