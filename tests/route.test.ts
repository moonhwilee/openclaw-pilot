import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { runRoute } from "../src/route/run.ts";
import { runVerify } from "../src/verify/run.ts";

async function tempStateRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pilot-state-"));
}

test("routing disabled returns explicit unavailable response", async () => {
  const result = await runRoute({
    input: "/plan Draft a local document strategy plan.",
    enabled: false,
  });

  assert.equal(result.status, "unavailable");
  assert.equal(result.backend, "openclaw-pilot");
  assert.match(result.fallback_message || "", /not enabled/);
  assert.match(result.fallback_message || "", /No legacy backend/);
  assert.match(result.user_report.next_action, /Enable Pilot exact routing/);
});

test("/plan exact route smoke uses new Pilot backend", async () => {
  const stateRoot = await tempStateRoot();
  const result = spawnSync(process.execPath, ["src/cli.ts", "route", "--enabled", "/plan Draft a local document strategy plan."], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PILOT_STATE_ROOT: stateRoot },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "routed");
  assert.equal(output.command, "/plan");
  assert.equal(output.backend, "openclaw-pilot");
  assert.match(output.result_summary.profile_expectations, /document_strategy/);
  assert.match(output.user_report.next_action, /Review the plan artifact/);
});

test("/verify exact route smoke evaluates document fixture", () => {
  const result = spawnSync(
    process.execPath,
    ["src/cli.ts", "route", "--enabled", "/verify fixtures/document_strategy/evidence-packet.json"],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "routed");
  assert.equal(output.command, "/verify");
  assert.equal(output.result_summary.verdict, "sufficient_evidence");
  assert.match(output.user_report.next_action, /verification artifact/);
});

test("/conv exact route smoke runs anchored conv fixture", () => {
  const result = spawnSync(process.execPath, ["src/cli.ts", "route", "--enabled", "/conv fixtures/document_strategy/conv-request.json"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "routed");
  assert.equal(output.command, "/conv");
  assert.equal(output.result_summary.status, "completed");
  assert.match(output.user_report.next_action, /Run \/verify/);
});

test("/goal exact route smoke runs approved scoped goal fixture", () => {
  const result = spawnSync(process.execPath, ["src/cli.ts", "route", "--enabled", "/goal fixtures/document_strategy/goal-request-approved.json"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "routed");
  assert.equal(output.command, "/goal");
  assert.equal(output.result_summary.status, "completed");
  assert.equal(output.user_report.status, "completed");
  assert.ok(output.user_report.evidence_pointers.some((path: string) => path.endsWith("receipts.jsonl")));
});

test("/goal exact route preserves awaiting approval status for draft goal fixture", () => {
  const result = spawnSync(process.execPath, ["src/cli.ts", "route", "--enabled", "/goal fixtures/document_strategy/goal-request-draft.json"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "awaiting_approval");
  assert.equal(output.command, "/goal");
  assert.equal(output.result_summary.status, "awaiting_approval");
  assert.match(output.user_report.next_action, /scoped approval/);
});

test("research profile fixture passes without changing core lifecycle", async () => {
  const stateRoot = await tempStateRoot();
  const result = await runVerify({
    packetPath: "fixtures/research/evidence-packet.json",
    stateRoot,
    now: new Date("2026-06-01T00:00:00.000Z"),
  });

  assert.equal(result.verdict, "sufficient_evidence");
  assert.equal(result.packet.claim.profile, "research");
});

test("unknown exact command does not fall through to legacy behavior", () => {
  const result = spawnSync(process.execPath, ["src/cli.ts", "route", "--enabled", "/oldgoal do something"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unsupported exact command/);
});
