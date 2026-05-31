import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { runGoal } from "../src/goal/run.ts";
import type { GoalRequest } from "../src/types.ts";

async function tempRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function baseGoalRequest(): GoalRequest {
  return {
    schema_version: "pilot.goal_request.v0",
    goal: {
      id: "scoped-local-goal",
      statement: "Create a bounded local goal artifact.",
      profile: "document_strategy",
    },
    plan: {
      goal: "Create a bounded local goal artifact.",
      scope: ["Create one local artifact in the run directory."],
      out_of_scope: ["External actions", "Shell execution", "Telegram routing"],
      success_criteria: ["A local goal artifact exists.", "A typed receipt exists after approved execution."],
      risks_assumptions: ["This is a local-only fixture."],
      action_boundaries: {
        allowed_actions: ["create_artifact"],
        approval_required_actions: ["create local goal artifact"],
        disallowed_actions: ["external_message", "shell_escape", "telegram_routing", "agent_spawn"],
      },
      verification_gates: ["goal-run.json exists", "receipts.jsonl records execution when approved"],
    },
    preflight: {
      risk_class: "low",
      typed_capabilities: ["create_artifact"],
      dangerous_action_gates: ["external_message", "payment", "credential_access", "server_restart", "deploy"],
      receipt_required: true,
      max_rounds: 1,
      stop_conditions: ["success_criteria_met", "approval_boundary_hit"],
    },
  };
}

test("pilot goal waits for scoped approval before execution", async () => {
  const root = await tempRoot("pilot-goal-");
  const stateRoot = await tempRoot("pilot-state-");
  const requestPath = join(root, "goal.json");
  await writeJson(requestPath, baseGoalRequest());

  const result = await runGoal({
    requestPath,
    stateRoot,
    now: new Date("2026-06-01T00:00:00.000Z"),
  });

  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.steps.length, 0);
  assert.equal(await fileExists(join(result.artifact_dir, "goal-run.json")), true);
  assert.equal(await fileExists(join(result.artifact_dir, "receipts.jsonl")), false);
  assert.equal(await fileExists(join(result.artifact_dir, "step-1-goal-artifact.md")), false);
});

test("pilot goal executes approved low-risk scoped artifact capability", async () => {
  const root = await tempRoot("pilot-goal-");
  const stateRoot = await tempRoot("pilot-state-");
  const request = baseGoalRequest();
  request.approval = {
    reference: "approval-001",
    approved: true,
    approved_scope: ["Create one local artifact in the run directory."],
    approved_capabilities: ["create_artifact"],
  };
  const requestPath = join(root, "goal.json");
  await writeJson(requestPath, request);

  const result = await runGoal({
    requestPath,
    stateRoot,
    now: new Date("2026-06-01T00:00:00.000Z"),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.steps.length, 1);
  assert.ok(result.findings.some((finding) => finding.code === "structural_evidence_sufficient"));
  assert.equal(result.steps[0].capability, "create_artifact");
  assert.ok(result.created_files.includes(result.steps[0].artifact_path));
  assert.ok(result.created_files.includes(join(result.artifact_dir, "receipts.jsonl")));
  assert.equal(await fileExists(join(result.artifact_dir, "step-1-goal-artifact.md")), true);

  const receipts = await readFile(join(result.artifact_dir, "receipts.jsonl"), "utf8");
  assert.match(receipts, /"schema_version":"pilot.receipt.v0"/);
  assert.match(receipts, /"approval_reference":"approval-001"/);
  assert.match(receipts, /"capability":"create_artifact"/);
});

test("pilot goal rejects overbroad approval boundaries", async () => {
  const root = await tempRoot("pilot-goal-");
  const stateRoot = await tempRoot("pilot-state-");
  const request = baseGoalRequest();
  request.approval = {
    reference: "approval-002",
    approved: true,
    approved_scope: ["do whatever is needed"],
    approved_capabilities: ["create_artifact"],
  };
  const requestPath = join(root, "goal.json");
  await writeJson(requestPath, request);

  const result = await runGoal({
    requestPath,
    stateRoot,
    now: new Date("2026-06-01T00:00:00.000Z"),
  });

  assert.equal(result.status, "needs_user_decision");
  assert.equal(result.steps.length, 0);
  assert.ok(result.findings.some((finding) => finding.message.includes("overbroad approved scope")));
});

test("pilot goal refuses dangerous or unsupported capabilities", async () => {
  const root = await tempRoot("pilot-goal-");
  const stateRoot = await tempRoot("pilot-state-");
  const request = baseGoalRequest();
  request.preflight.typed_capabilities = ["shell_escape"];
  request.approval = {
    reference: "approval-003",
    approved: true,
    approved_scope: ["Create one local artifact in the run directory."],
    approved_capabilities: ["shell_escape"],
  };
  const requestPath = join(root, "goal.json");
  await writeJson(requestPath, request);

  const result = await runGoal({
    requestPath,
    stateRoot,
    now: new Date("2026-06-01T00:00:00.000Z"),
  });

  assert.equal(result.status, "needs_user_decision");
  assert.equal(result.steps.length, 0);
  assert.ok(result.findings.some((finding) => finding.message.includes("dangerous")));
});

test("pilot goal requires separate approval for higher-risk goals", async () => {
  const root = await tempRoot("pilot-goal-");
  const stateRoot = await tempRoot("pilot-state-");
  const request = baseGoalRequest();
  request.preflight.risk_class = "high";
  request.approval = {
    reference: "approval-004",
    approved: true,
    approved_scope: ["Create one local artifact in the run directory."],
    approved_capabilities: ["create_artifact"],
  };
  const requestPath = join(root, "goal.json");
  await writeJson(requestPath, request);

  const result = await runGoal({
    requestPath,
    stateRoot,
    now: new Date("2026-06-01T00:00:00.000Z"),
  });

  assert.equal(result.status, "needs_user_decision");
  assert.equal(result.steps.length, 0);
  assert.ok(result.findings.some((finding) => finding.code === "explicit_high_risk_approval_required"));
});

test("vague pilot goal remains in plan semantics", async () => {
  const root = await tempRoot("pilot-goal-");
  const stateRoot = await tempRoot("pilot-state-");
  const request = baseGoalRequest();
  request.plan.ambiguity_questions = ["Which exact artifact should be produced?"];
  const requestPath = join(root, "goal.json");
  await writeJson(requestPath, request);

  const result = await runGoal({
    requestPath,
    stateRoot,
    now: new Date("2026-06-01T00:00:00.000Z"),
  });

  assert.equal(result.status, "needs_user_decision");
  assert.equal(result.steps.length, 0);
  assert.ok(result.findings.some((finding) => finding.code === "goal_requires_plan_semantics"));
});

test("pilot goal approved fixture can be run from the repository", () => {
  const result = spawnSync(process.execPath, ["src/cli.ts", "goal", "fixtures/document_strategy/goal-request-approved.json"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "completed");
  assert.equal(output.steps.length, 1);
});

test("pilot goal draft fixture waits for approval from the repository", () => {
  const result = spawnSync(process.execPath, ["src/cli.ts", "goal", "fixtures/document_strategy/goal-request-draft.json"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "awaiting_approval");
  assert.equal(output.steps.length, 0);
});
