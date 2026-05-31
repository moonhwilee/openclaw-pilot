import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { runLiveAdapter } from "../src/live-adapter/run.ts";

async function tempStateRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pilot-live-state-"));
}

test("live adapter keeps disabled commands unavailable without fallback", async () => {
  const result = await runLiveAdapter({
    input: "/verify fixtures/document_strategy/evidence-packet.json",
    enabledCommands: ["/plan"],
  });

  assert.equal(result.schema_version, "pilot.live_adapter.v0");
  assert.equal(result.route.status, "unavailable");
  assert.match(result.route.fallback_message || "", /No legacy backend/);
  assert.match(result.telegram_text, /Status: unavailable/);
  assert.match(result.telegram_text, /No legacy backend/);
});

test("live adapter formats enabled plan route as Telegram-safe text", async () => {
  const stateRoot = await tempStateRoot();
  const result = spawnSync(process.execPath, ["src/cli.ts", "live", "--enabled=/plan", "/plan Draft a local document strategy plan."], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PILOT_STATE_ROOT: stateRoot },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.route.status, "routed");
  assert.equal(output.route.command, "/plan");
  assert.match(output.telegram_text, /Pilot/);
  assert.match(output.telegram_text, /Evidence/);
  assert.match(output.telegram_text, /Next: Review the plan artifact/);
  assert.ok(output.telegram_text.length < 4000);
});

test("live adapter preserves goal approval wait in Telegram text", () => {
  const result = spawnSync(process.execPath, ["src/cli.ts", "live", "--enabled=/goal", "/goal fixtures/document_strategy/goal-request-draft.json"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.route.status, "awaiting_approval");
  assert.match(output.telegram_text, /Status: awaiting_approval/);
  assert.match(output.telegram_text, /scoped approval/);
});
