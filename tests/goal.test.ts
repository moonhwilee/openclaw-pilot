import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { withExecutionPlanHash } from "../src/execution-plan.ts";
import { getGoalCapabilityRunner, goalCapabilityNames } from "../src/goal/capabilities.ts";
import { runGoal } from "../src/goal/run.ts";
import { validateGoalRequest } from "../src/schema/index.ts";
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

function applyExecutionPlan(
  request: GoalRequest,
  options: {
    reference: string;
    capability?: string;
    scope?: string[];
    riskClass?: "low" | "medium" | "high";
  },
): void {
  const capability = options.capability || request.preflight.typed_capabilities[0] || "create_artifact";
  const scope = options.scope || ["Create one local artifact in the run directory."];
  const riskClass = options.riskClass || request.preflight.risk_class;
  request.preflight.risk_class = riskClass;
  request.preflight.typed_capabilities = [capability];
  request.execution_plan = withExecutionPlanHash({
    schema_version: "pilot.execution_plan.v0",
    plan_run_id: options.reference,
    goal_summary: request.goal.statement,
    steps: [
      {
        id: "step-1",
        capability,
        risk_class: riskClass,
        scope,
        inputs: { fixture: true },
        expected_artifacts:
          capability === "run_codex_session"
            ? ["runner-result.json", "runner-stdout.txt", "runner-stderr.txt"]
            : capability === "create_pilot_receipts_dashboard"
              ? ["pilot-receipts-dashboard.html"]
              : ["step-1-goal-artifact.md"],
        verification_gates: ["goal-run.json exists", "receipts.jsonl records execution"],
        stop_conditions: ["success_criteria_met", "approval_boundary_hit"],
      },
    ],
    forbidden_actions: ["external_message", "payment", "credential_access", "server_restart", "deploy"],
    requires_reapproval_if: ["Execution requires a capability, scope, or risk class outside this execution plan."],
  });
  request.approval = {
    reference: options.reference,
    approved: true,
    approved_scope: scope,
    approved_capabilities: [capability],
    execution_plan_ref: "fixture-execution-plan.json",
    execution_plan_hash: request.execution_plan.approval_subject_hash,
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
  assert.equal(await fileExists(join(result.artifact_dir, "lineage.jsonl")), true);
  assert.equal(await fileExists(join(stateRoot, "index", "lineage.jsonl")), true);
  assert.equal(await fileExists(join(result.artifact_dir, "receipts.jsonl")), false);
  assert.equal(await fileExists(join(result.artifact_dir, "step-1-goal-artifact.md")), false);
  const draftLineage = await readFile(join(result.artifact_dir, "lineage.jsonl"), "utf8");
  assert.ok(draftLineage.includes('"command":"/goal"'));
  assert.match(draftLineage, /"status":"awaiting_approval"/);
});

test("pilot goal executes approved low-risk scoped artifact capability", async () => {
  const root = await tempRoot("pilot-goal-");
  const stateRoot = await tempRoot("pilot-state-");
  const request = baseGoalRequest();
  applyExecutionPlan(request, { reference: "approval-001" });
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
  assert.ok(result.created_files.includes(join(result.artifact_dir, "lineage.jsonl")));
  assert.equal(await fileExists(join(result.artifact_dir, "step-1-goal-artifact.md")), true);

  const receipts = await readFile(join(result.artifact_dir, "receipts.jsonl"), "utf8");
  assert.match(receipts, /"schema_version":"pilot.receipt.v0"/);
  assert.match(receipts, /"approval_reference":"approval-001"/);
  assert.match(receipts, /"capability":"create_artifact"/);
  assert.match(receipts, /"execution_step_id":"step-1"/);
  const postExecutionEvidence = await readFile(join(result.artifact_dir, "post-execution-evidence.json"), "utf8");
  assert.match(postExecutionEvidence, /execution_step_id step-1/);
  assert.match(postExecutionEvidence, /every receipt must include execution_step_id/);
  const lineage = await readFile(join(result.artifact_dir, "lineage.jsonl"), "utf8");
  assert.match(lineage, /"approval_reference":"approval-001"/);
  assert.match(lineage, /"receipt_pointers":/);
});

test("approved goal without execution_plan does not fallback to preflight capabilities", async () => {
  const root = await tempRoot("pilot-goal-");
  const stateRoot = await tempRoot("pilot-state-");
  const request = baseGoalRequest();
  request.approval = {
    reference: "approval-missing-execution-plan",
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
  assert.equal(await fileExists(join(result.artifact_dir, "receipts.jsonl")), false);
  assert.ok(result.findings.some((finding) => finding.message.includes("approved goal requires execution plan")));
});

test("pilot goal creates approved local Pilot receipts dashboard prototype", async () => {
  const root = await tempRoot("pilot-goal-");
  const stateRoot = await tempRoot("pilot-state-");
  const seedRunDir = join(stateRoot, "runs", "20260601T000000Z-seeded-receipt");
  await mkdir(seedRunDir, { recursive: true });
  await writeFile(
    join(seedRunDir, "receipts.jsonl"),
    `${JSON.stringify({
      schema_version: "pilot.receipt.v0",
      action: "create_scoped_goal_artifact",
      capability: "create_artifact",
      run_id: "20260601T000000Z-seeded-receipt",
      step: 1,
      artifact_path: join(seedRunDir, "step-1-goal-artifact.md"),
      status: "ok",
      actor: "pilot.local",
      timestamp: "2026-06-01T00:00:00.000Z",
      primary_proof: true,
    })}\n`,
    "utf8",
  );
  const request = baseGoalRequest();
  request.goal.statement = "Create a local Pilot receipts dashboard prototype.";
  request.plan.action_boundaries.allowed_actions = ["create_pilot_receipts_dashboard"];
  request.preflight.typed_capabilities = ["create_pilot_receipts_dashboard"];
  applyExecutionPlan(request, {
    reference: "approval-dashboard-001",
    capability: "create_pilot_receipts_dashboard",
    scope: ["Create a local self-contained Pilot receipts dashboard in the goal run artifact directory."],
  });
  const requestPath = join(root, "goal.json");
  await writeJson(requestPath, request);

  const result = await runGoal({
    requestPath,
    stateRoot,
    now: new Date("2026-06-01T00:01:00.000Z"),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].capability, "create_pilot_receipts_dashboard");
  assert.ok(result.steps[0].artifact_path.endsWith("pilot-receipts-dashboard.html"));
  assert.equal(await fileExists(result.steps[0].artifact_path), true);

  const dashboard = await readFile(result.steps[0].artifact_path, "utf8");
  assert.match(dashboard, /Pilot Receipts Dashboard/);
  assert.match(dashboard, /create_artifact/);
  const receipts = await readFile(join(result.artifact_dir, "receipts.jsonl"), "utf8");
  assert.match(receipts, /"capability":"create_pilot_receipts_dashboard"/);
});

test("goal capability registry stays aligned with executable schema capabilities", () => {
  for (const capability of goalCapabilityNames) {
    const request = baseGoalRequest();
    request.plan.action_boundaries.allowed_actions = [capability];
    request.preflight.typed_capabilities = [capability];
    applyExecutionPlan(request, { reference: `approval-${capability}`, capability });

    assert.equal(typeof getGoalCapabilityRunner(capability), "function");
    assert.deepEqual(validateGoalRequest(request), []);
  }
});

test("pilot goal rejects overbroad approval boundaries", async () => {
  const root = await tempRoot("pilot-goal-");
  const stateRoot = await tempRoot("pilot-state-");
  const request = baseGoalRequest();
  applyExecutionPlan(request, { reference: "approval-002", scope: ["do whatever is needed"] });
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
  applyExecutionPlan(request, { reference: "approval-003", capability: "shell_escape" });
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

test("pilot goal executes approved higher-risk goals when the concrete plan covers the action", async () => {
  const root = await tempRoot("pilot-goal-");
  const stateRoot = await tempRoot("pilot-state-");
  const request = baseGoalRequest();
  request.preflight.risk_class = "high";
  applyExecutionPlan(request, { reference: "approval-004", riskClass: "high" });
  const requestPath = join(root, "goal.json");
  await writeJson(requestPath, request);

  const result = await runGoal({
    requestPath,
    stateRoot,
    now: new Date("2026-06-01T00:00:00.000Z"),
  });

    assert.equal(result.status, "completed");
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0].capability, "create_artifact");
    assert.ok(result.findings.some((finding) => finding.code === "structural_evidence_sufficient"));
    assert.equal(result.post_execution_verification?.verdict, "sufficient_evidence");
    assert.equal(result.lifecycle?.user_status, "completed_verified");
    assert.equal(result.lifecycle?.current_phase, "report");
    assert.ok(result.created_files.some((path) => path.endsWith("post-execution-evidence.json")));
    assert.ok(result.created_files.some((path) => path.endsWith("verification.json")));
});

test("pilot goal runs approved session runner vertical slice with recorded evidence", async () => {
  const previousEnv = {
    enabled: process.env.PILOT_SESSION_RUNNER_ENABLED,
    command: process.env.PILOT_SESSION_RUNNER_COMMAND,
    args: process.env.PILOT_SESSION_RUNNER_ARGS_JSON,
    timeout: process.env.PILOT_SESSION_RUNNER_TIMEOUT_MS,
  };
  const root = await tempRoot("pilot-goal-");
  const stateRoot = await tempRoot("pilot-state-");
  const request = baseGoalRequest();
  request.preflight.risk_class = "high";
  request.preflight.typed_capabilities = ["run_codex_session"];
  request.plan.action_boundaries.allowed_actions = ["run_codex_session"];
  request.plan.action_boundaries.approval_required_actions = ["execute the approved Codex/session runner task"];
  request.plan.verification_gates = ["runner-result.json exists", "runner-stdout.txt exists", "receipts.jsonl records execution"];
  applyExecutionPlan(request, {
    reference: "approval-runner-001",
    capability: "run_codex_session",
    scope: ["Execute the approved runner task and report results."],
    riskClass: "high",
  });
  const requestPath = join(root, "goal.json");
  await writeJson(requestPath, request);

  process.env.PILOT_SESSION_RUNNER_ENABLED = "true";
  process.env.PILOT_SESSION_RUNNER_COMMAND = process.execPath;
  process.env.PILOT_SESSION_RUNNER_ARGS_JSON = JSON.stringify([
    "-e",
    "process.stdin.resume(); process.stdin.on('end', () => { console.log('runner ok'); });",
  ]);
  process.env.PILOT_SESSION_RUNNER_TIMEOUT_MS = "5000";

  try {
    const result = await runGoal({
      requestPath,
      stateRoot,
      now: new Date("2026-06-01T00:02:00.000Z"),
    });

    assert.equal(result.status, "completed");
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0].capability, "run_codex_session");
    assert.equal(result.post_execution_verification?.verdict, "sufficient_evidence");
    assert.equal(result.lifecycle?.user_status, "completed_verified");
    assert.ok(result.created_files.some((path) => path.endsWith("runner-result.json")));
    assert.ok(result.created_files.some((path) => path.endsWith("runner-prompt.md")));
    assert.ok(result.created_files.some((path) => path.endsWith("runner-stdout.txt")));
    assert.ok(result.created_files.some((path) => path.endsWith("post-execution-evidence.json")));
    assert.ok(result.created_files.some((path) => path.endsWith("verification.json")));
    const runnerResult = await readFile(join(result.artifact_dir, "runner-result.json"), "utf8");
    assert.match(runnerResult, /"schema_version": "pilot.runner_result.v0"/);
    assert.match(runnerResult, /"status": "ok"/);
    assert.match(runnerResult, /"exit_code": 0/);
    const stdout = await readFile(join(result.artifact_dir, "runner-stdout.txt"), "utf8");
    assert.match(stdout, /runner ok/);
    const receipts = await readFile(join(result.artifact_dir, "receipts.jsonl"), "utf8");
    assert.match(receipts, /"capability":"run_codex_session"/);
    const final = await readFile(join(result.artifact_dir, "final.md"), "utf8");
    assert.match(final, /User Status: completed_verified/);
    assert.match(final, /Lifecycle:/);
    assert.match(final, /Post-Execution Verification/);
    assert.match(final, /sufficient_evidence/);
  } finally {
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

test("pilot goal runs bounded post-execution conv and re-verifies fixable findings", async () => {
  const root = await tempRoot("pilot-goal-");
  const stateRoot = await tempRoot("pilot-state-");
  const request = baseGoalRequest();
  request.plan.verification_gates = [
    "goal-run.json exists",
    "receipts.jsonl records execution when approved",
    "convergence note exists for post-execution gaps",
  ];
  applyExecutionPlan(request, { reference: "approval-conv-001" });
  const requestPath = join(root, "goal.json");
  await writeJson(requestPath, request);

  const result = await runGoal({
    requestPath,
    stateRoot,
    now: new Date("2026-06-01T00:04:00.000Z"),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.post_execution_verification?.verdict, "insufficient_evidence");
  assert.equal(result.post_execution_convergence?.status, "completed");
  assert.equal(result.post_execution_convergence?.rounds, 1);
  assert.equal(result.post_convergence_verification?.verdict, "sufficient_evidence");
  assert.equal(result.lifecycle?.user_status, "completed_after_convergence");
  assert.equal(result.lifecycle?.steps.find((step) => step.phase === "converge")?.status, "completed");
  assert.ok(result.findings.some((finding) => finding.code === "post_convergence_verification_sufficient"));
  assert.ok(result.created_files.some((path) => path.endsWith("post-execution-conv-request.json")));
  assert.ok(result.created_files.some((path) => path.endsWith("post-convergence-evidence.json")));
  assert.ok(result.created_files.some((path) => path.endsWith("round-1-evidence-update.md")));

  const final = await readFile(join(result.artifact_dir, "final.md"), "utf8");
  assert.match(final, /User Status: completed_after_convergence/);
  assert.match(final, /Post-Execution Convergence/);
  assert.match(final, /Post-Convergence Verification/);
  assert.match(final, /sufficient_evidence/);
});

test("pilot goal blocks approved session runner when runner env is disabled but keeps handoff artifacts", async () => {
  const previousEnabled = process.env.PILOT_SESSION_RUNNER_ENABLED;
  delete process.env.PILOT_SESSION_RUNNER_ENABLED;
  const root = await tempRoot("pilot-goal-");
  const stateRoot = await tempRoot("pilot-state-");
  const request = baseGoalRequest();
  request.preflight.risk_class = "high";
  request.preflight.typed_capabilities = ["run_codex_session"];
  request.plan.action_boundaries.allowed_actions = ["run_codex_session"];
  request.plan.action_boundaries.approval_required_actions = ["execute the approved Codex/session runner task"];
  applyExecutionPlan(request, {
    reference: "approval-runner-disabled-001",
    capability: "run_codex_session",
    scope: ["Execute the approved runner task and report results."],
    riskClass: "high",
  });
  const requestPath = join(root, "goal.json");
  await writeJson(requestPath, request);

  try {
    const result = await runGoal({
      requestPath,
      stateRoot,
      now: new Date("2026-06-01T00:03:00.000Z"),
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.steps.length, 0);
    assert.ok(result.findings.some((finding) => finding.code === "goal_capability_runner_failed"));
    assert.ok(result.created_files.some((path) => path.endsWith("runner-result.json")));
    assert.ok(result.created_files.some((path) => path.endsWith("runner-prompt.md")));
    const runnerResult = await readFile(join(result.artifact_dir, "runner-result.json"), "utf8");
    assert.match(runnerResult, /runner_disabled/);
  } finally {
    if (previousEnabled === undefined) delete process.env.PILOT_SESSION_RUNNER_ENABLED;
    else process.env.PILOT_SESSION_RUNNER_ENABLED = previousEnabled;
  }
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
  assert.equal(output.status, "routed");
  assert.equal(output.result_summary.status, "completed");
  assert.equal(output.result_summary.steps, 1);
});

test("pilot goal draft fixture waits for approval from the repository", () => {
  const result = spawnSync(process.execPath, ["src/cli.ts", "goal", "fixtures/document_strategy/goal-request-draft.json"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "awaiting_approval");
  assert.equal(output.result_summary.status, "awaiting_approval");
  assert.equal(output.result_summary.steps, 0);
});
