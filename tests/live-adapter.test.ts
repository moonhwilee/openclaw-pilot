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
  assert.match(output.telegram_text, /Run: \d{6}/);
  assert.match(output.telegram_text, /Next: Review the plan. To continue, reply "approve /);
  assert.ok(output.telegram_text.length < 4000);
});

test("live adapter shows usage for empty Pilot slash commands", () => {
  for (const command of ["/plan", "/goal", "/verify", "/conv"] as const) {
    const result = spawnSync(process.execPath, ["src/cli.ts", "live", `--enabled=${command}`, command], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.route.status, "needs_user_decision");
    assert.equal(output.route.command, command);
    assert.match(output.telegram_text, /Status: command_needs_input/);
    assert.match(output.telegram_text, /Usage/);
    assert.match(output.telegram_text, /Example/);
    assert.doesNotMatch(output.telegram_text, /Pilot command failed/);
  }
});

test("live adapter blocks goal request JSON shortcuts in Telegram text", () => {
  const result = spawnSync(process.execPath, ["src/cli.ts", "live", "--enabled=/goal", "/goal fixtures/document_strategy/goal-request-draft.json"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.route.status, "needs_user_decision");
  assert.match(output.telegram_text, /Status: artifact_shortcut_disabled/);
  assert.match(output.telegram_text, /pilot artifact goal-request/);
});

test("live adapter turns broad implementation verify into an approval-backed plan", async () => {
  const stateRoot = await tempStateRoot();
  const result = spawnSync(
    process.execPath,
    [
      "src/cli.ts",
      "live",
      "--enabled=/verify",
      "/verify 0.2.8, 0.2.9, 0.2.10, 0.2.11 업데이트 구현원칙과 오버엔지니어링 검증해줘",
    ],
    {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, PILOT_STATE_ROOT: stateRoot },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.route.status, "awaiting_approval");
  assert.equal(output.route.command, "/verify");
  assert.ok(output.telegram_text.length < 4000);
  assert.match(output.telegram_text, /Status: verify_plan_created/);
  assert.match(output.telegram_text, /Scope: v0\.2\.8, v0\.2\.9, v0\.2\.10, v0\.2\.11/);
  assert.match(output.telegram_text, /Next: Review the verification plan/);
  assert.doesNotMatch(output.telegram_text, /Provide a concrete run id/);

  const approve = spawnSync(process.execPath, ["src/cli.ts", "route", "--enabled", `approve ${output.route.result_summary.short_run_id}`], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PILOT_STATE_ROOT: stateRoot },
    encoding: "utf8",
  });

  assert.equal(approve.status, 0, approve.stderr);
  const approval = JSON.parse(approve.stdout);
  assert.equal(approval.result_summary.approval_status, "confirmed");
  assert.equal(approval.result_summary.approved_plan_run_id, output.route.result_summary.run_id);
  assert.notEqual(approval.user_report.status, "approval_target_not_found");
});
