import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { runPlan } from "../src/plan/run.ts";
import { runRoute } from "../src/route/run.ts";
import { appendRunIndexEntry, shortRunId } from "../src/state/run-index.ts";
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
  assert.match(output.result_summary.run_id, /^.+draft-a-local-document-strategy-plan$/);
  assert.match(output.result_summary.short_run_id, /^\d{6}$/);
  assert.equal(output.user_report.status, "plan_created");
  assert.match(output.user_report.next_action, /approve \d{6}/);
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

test("approve route resolves, records, and executes a scoped receipt run", async () => {
  const previousStateRoot = process.env.PILOT_STATE_ROOT;
  const stateRoot = await tempStateRoot();
  process.env.PILOT_STATE_ROOT = stateRoot;
  try {
    const plan = await runPlan({ request: "Draft a local approval resolver plan." });
    const shortId = shortRunId(plan.run_id);
    await appendRunIndexEntry(stateRoot, {
      schema_version: "pilot.run_index.v0",
      created_at: new Date("2026-06-01T00:00:00.000Z").toISOString(),
      channel: "telegram",
      chat_id: "343580315",
      sender_id: "343580315",
      source_message_id: "23094",
      source_update_id: "23094",
      command: "/plan",
      run_id: plan.run_id,
      short_run_id: shortId,
      status: "plan_created",
      artifact_dir: plan.artifact_dir,
      next_action: `Review the plan. To continue, reply "approve ${shortId}".`,
    });

    const output = await runRoute({
      input: `approve ${shortId}`,
      enabled: true,
      metadata: { channel: "telegram", chat_id: "343580315", sender_id: "343580315", message_id: "23095" },
    });

    assert.equal(output.status, "routed");
    assert.equal(output.command, "approve");
    assert.equal(output.result_summary?.approved_plan_run_id, plan.run_id);
    assert.equal(output.result_summary?.approved_plan_short_run_id, shortId);
    assert.equal(output.result_summary?.status, "completed");
    assert.equal(output.user_report.status, "completed_verified");
    assert.equal((output.result_summary?.lifecycle as { user_status?: string } | undefined)?.user_status, "completed_verified");
    assert.match(output.user_report.next_action, /Use receipts/);
    assert.ok(output.user_report.remaining_risks.includes("none"));
    assert.ok(output.user_report.evidence_pointers.some((path) => path.endsWith("index/approvals.jsonl")));
    assert.ok(output.user_report.evidence_pointers.some((path) => path.endsWith("receipts.jsonl")));
    assert.ok(plan.created_files.length > 0);
    const approvedRequest = JSON.parse(await readFile(join(plan.artifact_dir, "approved-goal-request.json"), "utf8"));
    assert.equal(approvedRequest.approval.reference, plan.run_id);
    assert.deepEqual(approvedRequest.approval.approved_capabilities, ["create_artifact"]);
  } finally {
    if (previousStateRoot === undefined) {
      delete process.env.PILOT_STATE_ROOT;
    } else {
      process.env.PILOT_STATE_ROOT = previousStateRoot;
    }
  }
});

test("approve route creates a Pilot receipts dashboard for dashboard receipt goals", async () => {
  const previousStateRoot = process.env.PILOT_STATE_ROOT;
  const stateRoot = await tempStateRoot();
  process.env.PILOT_STATE_ROOT = stateRoot;
  try {
    const plan = await runPlan({ request: "Build a tiny local dashboard prototype for reviewing Pilot receipts." });
    const shortId = shortRunId(plan.run_id);
    await appendRunIndexEntry(stateRoot, {
      schema_version: "pilot.run_index.v0",
      created_at: new Date("2026-06-01T00:00:00.000Z").toISOString(),
      channel: "telegram",
      chat_id: "343580315",
      sender_id: "343580315",
      source_message_id: "23150",
      source_update_id: "23150",
      command: "/goal",
      run_id: plan.run_id,
      short_run_id: shortId,
      status: "goal_plan_created",
      artifact_dir: plan.artifact_dir,
      next_action: `Review the plan. To continue, reply "approve ${shortId}".`,
    });

    const output = await runRoute({
      input: `approve ${shortId}`,
      enabled: true,
      metadata: { channel: "telegram", chat_id: "343580315", sender_id: "343580315", message_id: "23151" },
    });

    assert.equal(output.status, "routed");
    assert.equal(output.user_report.status, "completed_verified");
    assert.ok(output.user_report.evidence_pointers.some((path) => path.endsWith("pilot-receipts-dashboard.html")));
    const approvedRequest = JSON.parse(await readFile(join(plan.artifact_dir, "approved-goal-request.json"), "utf8"));
    assert.deepEqual(approvedRequest.approval.approved_capabilities, ["create_pilot_receipts_dashboard"]);
    assert.deepEqual(approvedRequest.preflight.typed_capabilities, ["create_pilot_receipts_dashboard"]);
  } finally {
    if (previousStateRoot === undefined) {
      delete process.env.PILOT_STATE_ROOT;
    } else {
      process.env.PILOT_STATE_ROOT = previousStateRoot;
    }
  }
});

test("approve route connects an implementation goal to the approved session runner slice", async () => {
  const previousStateRoot = process.env.PILOT_STATE_ROOT;
  const previousEnv = {
    enabled: process.env.PILOT_SESSION_RUNNER_ENABLED,
    command: process.env.PILOT_SESSION_RUNNER_COMMAND,
    args: process.env.PILOT_SESSION_RUNNER_ARGS_JSON,
    timeout: process.env.PILOT_SESSION_RUNNER_TIMEOUT_MS,
  };
  const stateRoot = await tempStateRoot();
  process.env.PILOT_STATE_ROOT = stateRoot;
  process.env.PILOT_SESSION_RUNNER_ENABLED = "true";
  process.env.PILOT_SESSION_RUNNER_COMMAND = process.execPath;
  process.env.PILOT_SESSION_RUNNER_ARGS_JSON = JSON.stringify([
    "-e",
    "process.stdin.resume(); process.stdin.on('end', () => { console.log('approved runner route ok'); });",
  ]);
  process.env.PILOT_SESSION_RUNNER_TIMEOUT_MS = "5000";
  try {
    const plan = await runPlan({ request: "Implement a tiny Pilot runner smoke check." });
    const shortId = shortRunId(plan.run_id);
    await appendRunIndexEntry(stateRoot, {
      schema_version: "pilot.run_index.v0",
      created_at: new Date("2026-06-01T00:00:00.000Z").toISOString(),
      channel: "telegram",
      chat_id: "343580315",
      sender_id: "343580315",
      source_message_id: "23250",
      source_update_id: "23250",
      command: "/goal",
      run_id: plan.run_id,
      short_run_id: shortId,
      status: "goal_plan_created",
      artifact_dir: plan.artifact_dir,
      next_action: `Review the plan. To continue, reply "approve ${shortId}".`,
    });

    const output = await runRoute({
      input: `approve ${shortId}`,
      enabled: true,
      metadata: { channel: "telegram", chat_id: "343580315", sender_id: "343580315", message_id: "23251" },
    });

    assert.equal(output.status, "routed");
    assert.equal(output.user_report.status, "completed_verified");
    assert.equal(output.result_summary?.status, "completed");
    assert.equal(output.result_summary?.steps, 1);
    const postVerify = output.result_summary?.post_execution_verification as { verdict?: string } | undefined;
    assert.equal(postVerify?.verdict, "sufficient_evidence");
    assert.ok(output.user_report.evidence_pointers.some((path) => path.endsWith("runner-result.json")));
    assert.ok(output.user_report.evidence_pointers.some((path) => path.endsWith("runner-stdout.txt")));
    assert.ok(output.user_report.evidence_pointers.some((path) => path.endsWith("post-execution-evidence.json")));
    assert.ok(output.user_report.evidence_pointers.some((path) => path.endsWith("verification.json")));
    const approvedRequest = JSON.parse(await readFile(join(plan.artifact_dir, "approved-goal-request.json"), "utf8"));
    assert.deepEqual(approvedRequest.approval.approved_capabilities, ["run_codex_session"]);
    assert.equal(approvedRequest.preflight.risk_class, "high");
  } finally {
    if (previousStateRoot === undefined) {
      delete process.env.PILOT_STATE_ROOT;
    } else {
      process.env.PILOT_STATE_ROOT = previousStateRoot;
    }
    if (previousEnv.enabled === undefined) delete process.env.PILOT_SESSION_RUNNER_ENABLED;
    else process.env.PILOT_SESSION_RUNNER_ENABLED = previousEnv.enabled;
    if (previousEnv.command === undefined) delete process.env.PILOT_SESSION_RUNNER_COMMAND;
    else process.env.PILOT_SESSION_RUNNER_COMMAND = previousEnv.command;
    if (previousEnv.args === undefined) delete process.env.PILOT_SESSION_RUNNER_ARGS_JSON;
    else process.env.PILOT_SESSION_RUNNER_ARGS_JSON = previousEnv.args;
    if (previousEnv.timeout === undefined) delete process.env.PILOT_SESSION_RUNNER_TIMEOUT_MS;
    else process.env.PILOT_SESSION_RUNNER_TIMEOUT_MS = previousEnv.timeout;
  }
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
  assert.equal(output.user_report.status, "completed_verified");
  assert.equal(output.result_summary.lifecycle.user_status, "completed_verified");
  assert.ok(output.user_report.evidence_pointers.some((path: string) => path.endsWith("receipts.jsonl")));
});

test("/goal freeform route creates a goal-intake plan without execution", async () => {
  const previousStateRoot = process.env.PILOT_STATE_ROOT;
  process.env.PILOT_STATE_ROOT = await tempStateRoot();
  try {
    const output = await runRoute({
      input: "/goal Build a tiny local dashboard prototype for reviewing Pilot receipts.",
      enabled: true,
      metadata: { channel: "telegram", chat_id: "343580315", sender_id: "343580315", message_id: "23150" },
    });

    assert.equal(output.status, "routed");
    assert.equal(output.command, "/goal");
    assert.equal(output.user_report.status, "goal_plan_created");
    assert.equal(output.result_summary?.mode, "goal_intake_plan");
    assert.match(String(output.result_summary?.short_run_id || ""), /^\d{6}$/);
    assert.match(output.user_report.next_action, /approve \d{6}/);
    assert.ok(output.user_report.evidence_pointers.some((path) => path.endsWith("goal.json")));
    assert.ok(output.user_report.remaining_risks.some((risk) => risk.includes("Execution not performed")));
  } finally {
    if (previousStateRoot === undefined) {
      delete process.env.PILOT_STATE_ROOT;
    } else {
      process.env.PILOT_STATE_ROOT = previousStateRoot;
    }
  }
});

test("/goal vague freeform route asks for clarification without handoff execution", async () => {
  const previousStateRoot = process.env.PILOT_STATE_ROOT;
  process.env.PILOT_STATE_ROOT = await tempStateRoot();
  try {
    const output = await runRoute({
      input: "/goal 도와줘",
      enabled: true,
    });

    assert.equal(output.status, "needs_user_decision");
    assert.equal(output.command, "/goal");
    assert.equal(output.user_report.status, "goal_needs_clarification");
    assert.equal(output.result_summary?.mode, "goal_intake_plan");
    assert.match(output.user_report.next_action, /Answer the ambiguity questions/);
    assert.ok(output.user_report.remaining_risks.some((risk) => risk.includes("concrete outcome")));
  } finally {
    if (previousStateRoot === undefined) {
      delete process.env.PILOT_STATE_ROOT;
    } else {
      process.env.PILOT_STATE_ROOT = previousStateRoot;
    }
  }
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
  assert.match(output.user_report.next_action, /Approve the concrete plan/);
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
