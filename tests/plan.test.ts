import { mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { runPlan } from "../src/plan/run.ts";
import { validateCommonPlanContract, validateEventRecord, validateExecutionPlan, validateGoalArtifact } from "../src/schema/index.ts";
import { isPhase1TerminalStatus } from "../src/state/index.ts";
import type { CommonPlanContract } from "../src/types.ts";

async function tempStateRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pilot-state-"));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test("runPlan creates the four v0 artifacts and completes without execution", async () => {
  const stateRoot = await tempStateRoot();
  const result = await runPlan({
    request: "Draft a launch-readiness planning checklist for a local-only pilot.",
    stateRoot,
    now: new Date("2026-06-01T00:00:00.000Z"),
  });

  assert.equal(result.status, "completed_plan");
  assert.equal(result.created_files.length, 6);
  for (const file of ["goal.json", "plan.md", "execution-plan.json", "events.jsonl", "final.md", "lineage.jsonl"]) {
    assert.equal(await fileExists(join(result.artifact_dir, file)), true, `${file} should exist`);
  }
  assert.equal(await fileExists(join(stateRoot, "index", "lineage.jsonl")), true);
  const lineage = await readFile(join(result.artifact_dir, "lineage.jsonl"), "utf8");
  assert.match(lineage, /"schema_version":"pilot.lineage.v0"/);
  assert.ok(lineage.includes('"command":"/plan"'));
  assert.match(lineage, /"record_type":"run"/);

  const goal = JSON.parse(await readFile(join(result.artifact_dir, "goal.json"), "utf8"));
  assert.equal(goal.schema_version, "pilot.goal.v0");
  assert.equal(goal.status, "completed_plan");
  assert.equal(goal.profile, "document_strategy");
  assert.deepEqual(validateGoalArtifact(goal), []);
  assert.equal(isPhase1TerminalStatus(goal.status), true);

  const events = await readFile(join(result.artifact_dir, "events.jsonl"), "utf8");
  assert.match(events, /"execution":"not_performed"/);
  for (const line of events.trim().split("\n")) {
    assert.deepEqual(validateEventRecord(JSON.parse(line)), []);
  }
  assert.equal(await fileExists(join(result.artifact_dir, "approval.json")), false);
  assert.equal(await fileExists(join(result.artifact_dir, "receipts.jsonl")), false);
  const executionPlan = JSON.parse(await readFile(join(result.artifact_dir, "execution-plan.json"), "utf8"));
  assert.deepEqual(validateExecutionPlan(executionPlan), []);
});

test("vague request ends in needs_user_decision and records ambiguity", async () => {
  const stateRoot = await tempStateRoot();
  const result = await runPlan({
    request: "해줘",
    stateRoot,
    now: new Date("2026-06-01T00:00:00.000Z"),
  });

  assert.equal(result.status, "needs_user_decision");
  assert.ok(result.goal.ambiguity_questions.length > 0);
  assert.ok(result.plan.ambiguity_questions?.length);
});

test("generated plan satisfies the Common Plan Contract", async () => {
  const stateRoot = await tempStateRoot();
  const result = await runPlan({
    request: "Prepare a document strategy plan for Phase 1 validation.",
    stateRoot,
    now: new Date("2026-06-01T00:00:00.000Z"),
  });

  assert.deepEqual(validateCommonPlanContract(result.plan), []);
});

test("large implementation plans include outcome-first phase and slice guidance", async () => {
  const stateRoot = await tempStateRoot();
  const result = await runPlan({
    request: "Implement a large refactor of Pilot goal planning with phase gated runtime milestones.",
    stateRoot,
    now: new Date("2026-06-01T00:00:00.000Z"),
  });

  assert.equal(result.status, "completed_plan");
  assert.match(result.plan.outcome_summary || "", /approval-ready plan/);
  assert.ok(result.plan.context_summary?.some((item) => item.includes("typed execution-plan hash")));
  assert.ok(result.plan.phase_plan?.length);
  assert.ok(result.plan.phase_plan?.every((phase) => !["execute", "verify", "converge", "reverify", "report"].includes(phase.goal_phase)));
  assert.deepEqual(validateCommonPlanContract(result.plan), []);

  const planMarkdown = await readFile(join(result.artifact_dir, "plan.md"), "utf8");
  assert.ok(planMarkdown.indexOf("## Outcome First") < planMarkdown.indexOf("## Scope"));
  assert.match(planMarkdown, /## Phase \/ Slice Plan/);
  assert.match(planMarkdown, /goal_phase_1_plan_quality/);

  const executionPlan = JSON.parse(await readFile(join(result.artifact_dir, "execution-plan.json"), "utf8"));
  assert.deepEqual(validateExecutionPlan(executionPlan), []);
  assert.ok(executionPlan.goal_milestones?.length);
  assert.equal(executionPlan.goal_milestones[0].phase_index, 1);
  assert.equal(executionPlan.goal_milestones[0].status, "planned");
  assert.ok(executionPlan.goal_milestones[0].slice_ids.includes("slice_1_outcome_first_plan"));
});

test("overbroad allowed actions are rejected by schema validation", () => {
  const plan: CommonPlanContract = {
    goal: "Bad plan",
    scope: ["anything"],
    out_of_scope: ["nothing"],
    success_criteria: ["done"],
    risks_assumptions: ["none"],
    action_boundaries: {
      allowed_actions: ["use tools", "fix issue"],
      approval_required_actions: [],
      disallowed_actions: [],
    },
    verification_gates: ["review"],
  };

  const errors = validateCommonPlanContract(plan);
  assert.ok(errors.some((error) => error.includes("overbroad allowed action")));
});

test("goal phases must not reuse lifecycle phase names", () => {
  const plan: CommonPlanContract = {
    goal: "Bad phase plan",
    outcome_summary: "Bad phase plan should fail validation.",
    context_summary: ["testing invalid phase naming"],
    phase_plan: [
      {
        goal_phase: "execute",
        objective: "This collides with lifecycle phase naming.",
        slices: [
          {
            id: "slice_1",
            objective: "bad slice",
            check: ["check"],
            convergence_gate: "gate",
          },
        ],
        phase_verify: "verify",
        pass_criteria: ["pass"],
      },
    ],
    scope: ["scope"],
    out_of_scope: ["none"],
    success_criteria: ["done"],
    risks_assumptions: ["risk"],
    action_boundaries: {
      allowed_actions: ["create_plan_artifact"],
      approval_required_actions: [],
      disallowed_actions: [],
    },
    verification_gates: ["review"],
  };

  const errors = validateCommonPlanContract(plan);
  assert.ok(errors.some((error) => error.includes("must not reuse lifecycle phase name")));
});

test("execution plan milestones must not reuse lifecycle phase names", () => {
  const executionPlan = {
    schema_version: "pilot.execution_plan.v0" as const,
    plan_run_id: "test-plan",
    approval_subject_hash: "",
    goal_summary: "Bad milestone plan",
    goal_milestones: [
      {
        phase_index: 1,
        goal_phase: "verify",
        objective: "This collides with lifecycle phase naming.",
        slice_ids: ["slice_1"],
        phase_verify: "phase check",
        pass_criteria: ["pass"],
        status: "planned" as const,
      },
    ],
    steps: [
      {
        id: "step-1",
        capability: "create_artifact",
        risk_class: "low" as const,
        scope: ["Create a bounded local artifact."],
        inputs: {},
        expected_artifacts: ["artifact.md"],
        verification_gates: ["artifact exists"],
        stop_conditions: ["success_criteria_met"],
      },
    ],
    forbidden_actions: ["external_message"],
    requires_reapproval_if: ["scope changes"],
  };

  const errors = validateExecutionPlan(executionPlan);
  assert.ok(errors.some((error) => error.includes("must not reuse lifecycle phase name")));
});

test("CLI goal mode requires a natural objective or advanced request path", () => {
  const result = spawnSync(process.execPath, ["src/cli.ts", "goal"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires a natural-language objective or advanced goal request JSON path/);
});

test("CLI smoke creates a local plan artifact", async () => {
  const stateRoot = await tempStateRoot();
  const result = spawnSync(
    process.execPath,
    ["src/cli.ts", "plan", "Draft a document strategy plan for a local pilot."],
    {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, PILOT_STATE_ROOT: stateRoot },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "completed_plan");
  assert.equal(await fileExists(join(output.artifact_dir, "goal.json")), true);
});

test("CLI goal natural objective creates a goal-intake plan without execution", async () => {
  const stateRoot = await tempStateRoot();
  const result = spawnSync(
    process.execPath,
    ["src/cli.ts", "goal", "Draft a CLI natural goal plan and wait for approval."],
    {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, PILOT_STATE_ROOT: stateRoot },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "routed");
  assert.equal(output.result_summary.mode, "goal_intake_plan");
  assert.equal(output.user_report.status, "goal_plan_created");
});
