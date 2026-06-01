import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { hashExecutionPlan, withExecutionPlanHash } from "../src/execution-plan.ts";
import { runPlan } from "../src/plan/run.ts";
import { runRoute } from "../src/route/run.ts";
import { runGoal } from "../src/goal/run.ts";
import { appendApprovalEntry } from "../src/state/approval-index.ts";
import { appendLineageRecord } from "../src/state/lineage.ts";
import { appendRunIndexEntry, shortRunId } from "../src/state/run-index.ts";
import { runVerify } from "../src/verify/run.ts";
import type { ConvCheckpoint, ConvRequest, GoalRequest, GoalRunResult } from "../src/types.ts";

async function tempStateRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pilot-state-"));
}

async function convergenceGoalRequest(root: string, id: string): Promise<string> {
  const request = JSON.parse(
    await readFile("fixtures/document_strategy/goal-request-approved.json", "utf8"),
  ) as GoalRequest;
  request.goal.id = id;
  request.plan.verification_gates = [
    "goal-run.json exists",
    "receipts.jsonl records execution when approved",
    "convergence note exists for post-execution gaps",
  ];
  request.execution_plan = withExecutionPlanHash({
    ...(request.execution_plan || {
      schema_version: "pilot.execution_plan.v0" as const,
      goal_summary: request.goal.statement,
      steps: [],
      forbidden_actions: [],
      requires_reapproval_if: [],
    }),
    plan_run_id: `${id}-approval`,
  });
  request.approval = {
    reference: `${id}-approval`,
    approved: true,
    approved_scope: ["Create one local artifact in the run directory."],
    approved_capabilities: ["create_artifact"],
    execution_plan_ref: "fixture-execution-plan.json",
    execution_plan_hash: request.execution_plan.approval_subject_hash,
  };
  const requestPath = join(root, `${id}.json`);
  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  return requestPath;
}

async function planExecutionApprovalFields(artifactDir: string): Promise<{
  execution_plan_ref: string;
  execution_plan_hash: string;
  approved_capabilities: string[];
  approved_scope: string[];
}> {
  const executionPlanPath = join(artifactDir, "execution-plan.json");
  const executionPlan = JSON.parse(await readFile(executionPlanPath, "utf8")) as GoalRequest["execution_plan"];
  if (!executionPlan) throw new Error("missing test execution plan");
  return {
    execution_plan_ref: executionPlanPath,
    execution_plan_hash: hashExecutionPlan(executionPlan),
    approved_capabilities: executionPlan.steps.map((step) => step.capability),
    approved_scope: executionPlan.steps.flatMap((step) => step.scope),
  };
}

function standaloneConvRequest(anchorPath: string): ConvRequest {
  return {
    schema_version: "pilot.conv_request.v0",
    anchor: {
      id: "standalone-conv-resume",
      path: anchorPath,
      description: "Standalone conv resume anchor.",
    },
    findings: [
      { id: "finding-one", description: "Already reduced finding.", status: "reduced" },
      { id: "finding-two", description: "Open finding to resume.", status: "open" },
    ],
    preflight: {
      risk_class: "low",
      allowed_capabilities: ["local_artifact_note", "finding_status_update"],
      forbidden_capabilities: ["external_message", "deploy", "credential_access", "shell_execution", "telegram_routing"],
      max_rounds: 2,
      stop_condition: "all_findings_reduced",
    },
  };
}

async function interruptedGoalRun(
  stateRoot: string,
  goal: GoalRunResult,
  suffix: string,
  mutate: (goalRun: GoalRunResult) => void,
): Promise<{ run_id: string; artifact_dir: string }> {
  const runId = `${goal.run_id}-${suffix}`;
  const artifactDir = join(stateRoot, "runs", runId);
  await mkdir(artifactDir, { recursive: true });
  const receipts = await readFile(join(goal.artifact_dir, "receipts.jsonl"), "utf8");
  await writeFile(join(artifactDir, "receipts.jsonl"), receipts, "utf8");
  const goalRun = JSON.parse(await readFile(join(goal.artifact_dir, "goal-run.json"), "utf8")) as GoalRunResult;
  goalRun.run_id = runId;
  goalRun.status = "blocked";
  goalRun.artifact_dir = artifactDir;
  mutate(goalRun);
  await writeFile(join(artifactDir, "goal-run.json"), `${JSON.stringify(goalRun, null, 2)}\n`, "utf8");
  await appendRunIndexEntry(stateRoot, {
    schema_version: "pilot.run_index.v0",
    created_at: new Date("2026-06-01T00:00:03.000Z").toISOString(),
    channel: "telegram",
    chat_id: "343580315",
    sender_id: "343580315",
    source_message_id: "23335",
    source_update_id: "23335",
    command: "/goal",
    run_id: runId,
    short_run_id: shortRunId(runId),
    status: "goal_execution_interrupted",
    artifact_dir: artifactDir,
    next_action: `Run resume ${runId} to continue the interrupted goal.`,
  });
  return { run_id: runId, artifact_dir: artifactDir };
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

test("recovery list and status inspect recent Pilot runs without mutating execution state", async () => {
  const previousStateRoot = process.env.PILOT_STATE_ROOT;
  const stateRoot = await tempStateRoot();
  process.env.PILOT_STATE_ROOT = stateRoot;
  try {
    const plan = await runPlan({ request: "Draft a recovery status smoke plan." });
    const shortId = shortRunId(plan.run_id);

    const list = await runRoute({ input: "list", enabled: true });
    assert.equal(list.status, "routed");
    assert.equal(list.command, "list");
    assert.equal(list.user_report.status, "recovery_list");
    assert.ok(list.user_report.evidence_pointers.some((pointer) => pointer.includes(shortId)));
    assert.match(list.user_report.next_action, new RegExp(`status ${shortId}`));

    const status = await runRoute({ input: `status ${shortId}`, enabled: true });
    assert.equal(status.status, "routed");
    assert.equal(status.command, "status");
    assert.equal(status.user_report.status, "completed_plan");
    assert.match(status.user_report.next_action, /approve/);
    const run = status.result_summary?.run as { run_id?: string; lineage_records?: number; available_artifacts?: string[] } | undefined;
    assert.equal(run?.run_id, plan.run_id);
    assert.equal(run?.lineage_records, 1);
    assert.ok(run?.available_artifacts?.some((artifact) => artifact.endsWith("final.md")));
  } finally {
    if (previousStateRoot === undefined) {
      delete process.env.PILOT_STATE_ROOT;
    } else {
      process.env.PILOT_STATE_ROOT = previousStateRoot;
    }
  }
});

test("recovery commands surface copyable full run ids when a short id is ambiguous", async () => {
  const previousStateRoot = process.env.PILOT_STATE_ROOT;
  const stateRoot = await tempStateRoot();
  process.env.PILOT_STATE_ROOT = stateRoot;
  try {
    const firstRunId = "20260601T000000Z-first-short-id-collision";
    const secondRunId = "20260601T000000Z-second-short-id-collision";
    const shortId = shortRunId(firstRunId);
    assert.equal(shortId, shortRunId(secondRunId));

    for (const [index, runId] of [firstRunId, secondRunId].entries()) {
      const artifactDir = join(stateRoot, "runs", runId);
      await mkdir(artifactDir, { recursive: true });
      await appendRunIndexEntry(stateRoot, {
        schema_version: "pilot.run_index.v0",
        created_at: new Date(`2026-06-01T00:00:0${index}.000Z`).toISOString(),
        channel: "telegram",
        chat_id: "343580315",
        sender_id: "343580315",
        source_message_id: `collision-${index}`,
        source_update_id: `collision-${index}`,
        command: "/plan",
        run_id: runId,
        short_run_id: shortId,
        status: "plan_created",
        artifact_dir: artifactDir,
        next_action: `Review the plan. To continue, reply "approve ${shortId}".`,
      });
    }

    const status = await runRoute({ input: `status ${shortId}`, enabled: true });
    assert.equal(status.status, "needs_user_decision");
    assert.equal(status.user_report.status, "recovery_ambiguous");
    assert.ok(status.user_report.evidence_pointers.some((pointer) => pointer.includes(`retry="status ${firstRunId}"`)));
    assert.ok(status.user_report.evidence_pointers.some((pointer) => pointer.includes(`retry="status ${secondRunId}"`)));
    assert.ok(status.user_report.remaining_risks.some((risk) => risk.includes("Short run ids are time handles")));
    assert.match(status.user_report.next_action, new RegExp(`status ${firstRunId}`));

    const resume = await runRoute({ input: `resume ${shortId}`, enabled: true });
    assert.equal(resume.status, "needs_user_decision");
    assert.equal(resume.user_report.status, "recovery_resume_ambiguous");
    assert.ok(resume.user_report.evidence_pointers.some((pointer) => pointer.includes(`retry="resume ${firstRunId}"`)));
    assert.match(resume.user_report.next_action, new RegExp(`resume ${firstRunId}`));

    const cancel = await runRoute({ input: `cancel ${shortId} duplicate`, enabled: true });
    assert.equal(cancel.status, "needs_user_decision");
    assert.equal(cancel.user_report.status, "recovery_cancel_ambiguous");
    assert.ok(cancel.user_report.evidence_pointers.some((pointer) => pointer.includes(`retry="cancel ${firstRunId}"`)));
    assert.match(cancel.user_report.next_action, new RegExp(`cancel ${firstRunId}`));
  } finally {
    if (previousStateRoot === undefined) {
      delete process.env.PILOT_STATE_ROOT;
    } else {
      process.env.PILOT_STATE_ROOT = previousStateRoot;
    }
  }
});

test("recovery cancel marks a run and blocks later approval", async () => {
  const previousStateRoot = process.env.PILOT_STATE_ROOT;
  const stateRoot = await tempStateRoot();
  process.env.PILOT_STATE_ROOT = stateRoot;
  try {
    const plan = await runPlan({ request: "Draft a recovery cancel smoke plan." });
    const shortId = shortRunId(plan.run_id);
    await appendRunIndexEntry(stateRoot, {
      schema_version: "pilot.run_index.v0",
      created_at: new Date("2026-06-01T00:00:00.000Z").toISOString(),
      channel: "telegram",
      chat_id: "343580315",
      sender_id: "343580315",
      source_message_id: "23310",
      source_update_id: "23310",
      command: "/plan",
      run_id: plan.run_id,
      short_run_id: shortId,
      status: "plan_created",
      artifact_dir: plan.artifact_dir,
      next_action: `Review the plan. To continue, reply "approve ${shortId}".`,
    });

    const cancel = await runRoute({ input: `cancel ${shortId} owner changed priority`, enabled: true });
    assert.equal(cancel.status, "routed");
    assert.equal(cancel.command, "cancel");
    assert.equal(cancel.user_report.status, "cancelled");
    assert.ok(cancel.user_report.evidence_pointers.some((path) => path.endsWith("cancel.json")));

    const status = await runRoute({ input: `status ${shortId}`, enabled: true });
    assert.equal(status.status, "routed");
    assert.equal(status.user_report.status, "cancelled");

    const resume = await runRoute({ input: `resume ${shortId}`, enabled: true });
    assert.equal(resume.status, "blocked");
    assert.equal(resume.user_report.status, "resume_blocked_cancelled");

    const approve = await runRoute({
      input: `approve ${shortId}`,
      enabled: true,
      metadata: { channel: "telegram", chat_id: "343580315", sender_id: "343580315", message_id: "23311" },
    });
    assert.equal(approve.status, "blocked");
    assert.equal(approve.user_report.status, "approval_target_invalid");
    assert.ok(approve.user_report.remaining_risks.some((risk) => risk.includes("cancelled")));
  } finally {
    if (previousStateRoot === undefined) {
      delete process.env.PILOT_STATE_ROOT;
    } else {
      process.env.PILOT_STATE_ROOT = previousStateRoot;
    }
  }
});

test("recovery status and resume surface stale timeout visibility", async () => {
  const previousStateRoot = process.env.PILOT_STATE_ROOT;
  const previousStaleAfter = process.env.PILOT_RECOVERY_STALE_AFTER_MS;
  const stateRoot = await tempStateRoot();
  process.env.PILOT_STATE_ROOT = stateRoot;
  process.env.PILOT_RECOVERY_STALE_AFTER_MS = "1";
  try {
    const plan = await runPlan({ request: "Draft a stale recovery visibility smoke plan." });
    const shortId = shortRunId(plan.run_id);
    await delay(5);

    const status = await runRoute({ input: `status ${shortId}`, enabled: true });
    assert.equal(status.status, "routed");
    assert.equal(status.user_report.status, "completed_plan");
    assert.ok(status.user_report.remaining_risks.some((risk) => risk.includes("freshness window")));
    const run = status.result_summary?.run as { recovery?: { status?: string; timeout_visible?: boolean } } | undefined;
    assert.equal(run?.recovery?.status, "stale");
    assert.equal(run?.recovery?.timeout_visible, true);

    const resume = await runRoute({ input: `resume ${shortId}`, enabled: true });
    assert.equal(resume.status, "needs_user_decision");
    assert.equal(resume.user_report.status, "resume_needs_recovery_decision");
    assert.ok(resume.user_report.remaining_risks.some((risk) => risk.includes("freshness window")));
    assert.ok(resume.user_report.evidence_pointers.some((pointer) => pointer.endsWith("resume.json")));
    const resumeArtifact = resume.result_summary?.resume_artifact as string | undefined;
    assert.ok(resumeArtifact?.endsWith("resume.json"));
    const directive = JSON.parse(await readFile(resumeArtifact, "utf8")) as {
      schema_version?: string;
      automatic_execution_performed?: boolean;
      process_resume_supported?: boolean;
    };
    assert.equal(directive.schema_version, "pilot.recovery_resume_directive.v0");
    assert.equal(directive.automatic_execution_performed, false);
    assert.equal(directive.process_resume_supported, false);

    const statusAfterResume = await runRoute({ input: `status ${shortId}`, enabled: true });
    const runAfterResume = statusAfterResume.result_summary?.run as { recovery?: { status?: string } } | undefined;
    assert.equal(runAfterResume?.recovery?.status, "stale");

    const list = await runRoute({ input: "list", enabled: true });
    assert.equal(list.status, "routed");
    assert.ok(list.user_report.remaining_risks.some((risk) => risk.includes("stale")));
  } finally {
    if (previousStateRoot === undefined) {
      delete process.env.PILOT_STATE_ROOT;
    } else {
      process.env.PILOT_STATE_ROOT = previousStateRoot;
    }
    if (previousStaleAfter === undefined) {
      delete process.env.PILOT_RECOVERY_STALE_AFTER_MS;
    } else {
      process.env.PILOT_RECOVERY_STALE_AFTER_MS = previousStaleAfter;
    }
  }
});

test("resume auto-runs approved runner work from the execute checkpoint", async () => {
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
    "process.stdin.resume(); process.stdin.on('end', () => { console.log('auto resume runner ok'); });",
  ]);
  process.env.PILOT_SESSION_RUNNER_TIMEOUT_MS = "5000";
  try {
    const plan = await runPlan({ request: "Implement a tiny auto resume runner smoke check." });
    const shortId = shortRunId(plan.run_id);
    await appendRunIndexEntry(stateRoot, {
      schema_version: "pilot.run_index.v0",
      created_at: new Date("2026-06-01T00:00:00.000Z").toISOString(),
      channel: "telegram",
      chat_id: "343580315",
      sender_id: "343580315",
      source_message_id: "23330",
      source_update_id: "23330",
      command: "/goal",
      run_id: plan.run_id,
      short_run_id: shortId,
      status: "goal_plan_created",
      artifact_dir: plan.artifact_dir,
      next_action: `Review the plan. To continue, reply "approve ${shortId}".`,
    });
    const approvalFields = await planExecutionApprovalFields(plan.artifact_dir);
    await appendApprovalEntry(stateRoot, {
      schema_version: "pilot.approval.v0",
      created_at: new Date("2026-06-01T00:00:01.000Z").toISOString(),
      channel: "telegram",
      chat_id: "343580315",
      sender_id: "343580315",
      source_message_id: "23331",
      source_update_id: "23331",
      reference: shortId,
      run_id: plan.run_id,
      short_run_id: shortId,
      artifact_dir: plan.artifact_dir,
      status: "approved",
      approved_scope: approvalFields.approved_scope,
      approved_capabilities: approvalFields.approved_capabilities,
      execution_plan_ref: approvalFields.execution_plan_ref,
      execution_plan_hash: approvalFields.execution_plan_hash,
      next_action: `Run /goal ${shortId} to execute the approved Codex/session runner slice.`,
    });
    await appendLineageRecord(stateRoot, {
      schema_version: "pilot.lineage.v0",
      created_at: new Date("2026-06-01T00:00:01.000Z").toISOString(),
      record_type: "approval",
      command: "approve",
      run_id: plan.run_id,
      short_run_id: shortId,
      status: "approved",
      state_root: stateRoot,
      artifact_dir: plan.artifact_dir,
      evidence_pointers: [],
      receipt_pointers: [],
      resume_hint: `Run /goal ${shortId} to execute the approved Codex/session runner slice.`,
      metadata: { execution_plan_hash: approvalFields.execution_plan_hash },
    });

    const output = await runRoute({
      input: `resume ${shortId}`,
      enabled: true,
      metadata: { channel: "telegram", chat_id: "343580315", sender_id: "343580315", message_id: "23332" },
    });

    assert.equal(output.status, "routed");
    assert.equal(output.user_report.status, "auto_resumed_execute");
    assert.ok(output.user_report.evidence_pointers.some((path) => path.endsWith("resume.json")));
    assert.ok(output.user_report.evidence_pointers.some((path) => path.endsWith("resume-lock.json")));
    assert.ok(output.user_report.evidence_pointers.some((path) => path.endsWith("auto-resume-attempt.json")));
    assert.ok(output.user_report.evidence_pointers.some((path) => path.endsWith("runner-result.json")));
    assert.equal(output.result_summary?.status, "auto_resume_executed");
    assert.equal(output.result_summary?.checkpoint_phase, "execute");

    const duplicate = await runRoute({ input: `resume ${shortId}`, enabled: true });
    assert.equal(duplicate.status, "needs_user_decision");
    assert.ok(duplicate.user_report.remaining_risks.some((risk) => risk.includes("auto-resume lock")));
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

test("resume auto-runs verification from the verify checkpoint without re-executing", async () => {
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
    "process.stdin.resume(); process.stdin.on('end', () => { console.log('verify checkpoint runner ok'); });",
  ]);
  process.env.PILOT_SESSION_RUNNER_TIMEOUT_MS = "5000";
  try {
    const plan = await runPlan({ request: "Implement a tiny verify checkpoint resume smoke check." });
    const planShortId = shortRunId(plan.run_id);
    await appendRunIndexEntry(stateRoot, {
      schema_version: "pilot.run_index.v0",
      created_at: new Date("2026-06-01T00:00:00.000Z").toISOString(),
      channel: "telegram",
      chat_id: "343580315",
      sender_id: "343580315",
      source_message_id: "23332",
      source_update_id: "23332",
      command: "/goal",
      run_id: plan.run_id,
      short_run_id: planShortId,
      status: "goal_plan_created",
      artifact_dir: plan.artifact_dir,
      next_action: `Review the plan. To continue, reply "approve ${planShortId}".`,
    });
    const approvalFields = await planExecutionApprovalFields(plan.artifact_dir);
    await appendApprovalEntry(stateRoot, {
      schema_version: "pilot.approval.v0",
      created_at: new Date("2026-06-01T00:00:01.000Z").toISOString(),
      channel: "telegram",
      chat_id: "343580315",
      sender_id: "343580315",
      source_message_id: "23333",
      source_update_id: "23333",
      reference: planShortId,
      run_id: plan.run_id,
      short_run_id: planShortId,
      artifact_dir: plan.artifact_dir,
      status: "approved",
      approved_scope: approvalFields.approved_scope,
      approved_capabilities: approvalFields.approved_capabilities,
      execution_plan_ref: approvalFields.execution_plan_ref,
      execution_plan_hash: approvalFields.execution_plan_hash,
      next_action: `Run /goal ${planShortId} to execute the approved Codex/session runner slice.`,
    });

    const approvedRequestPath = join(plan.artifact_dir, "approved-execution-request.json");
    const approved = await runRoute({ input: `approve ${planShortId}`, enabled: true });
    assert.equal(approved.status, "routed");

    const goal = await runGoal({ requestPath: approvedRequestPath, stateRoot });
    const interruptedRunId = `${goal.run_id}-verify-checkpoint`;
    const interruptedShortId = shortRunId(interruptedRunId);
    const interruptedArtifactDir = join(stateRoot, "runs", interruptedRunId);
    await mkdir(interruptedArtifactDir, { recursive: true });
    await writeFile(
      join(interruptedArtifactDir, "receipts.jsonl"),
      await readFile(join(goal.artifact_dir, "receipts.jsonl"), "utf8"),
      "utf8",
    );
    await appendRunIndexEntry(stateRoot, {
      schema_version: "pilot.run_index.v0",
      created_at: new Date("2026-06-01T00:00:02.000Z").toISOString(),
      channel: "telegram",
      chat_id: "343580315",
      sender_id: "343580315",
      source_message_id: "23334",
      source_update_id: "23334",
      command: "/goal",
      run_id: interruptedRunId,
      short_run_id: interruptedShortId,
      status: "goal_execution_interrupted_before_verify",
      artifact_dir: interruptedArtifactDir,
      next_action: `Run resume ${interruptedRunId} to verify the interrupted execution.`,
    });

    const goalRunPath = join(interruptedArtifactDir, "goal-run.json");
    const goalRun = JSON.parse(await readFile(join(goal.artifact_dir, "goal-run.json"), "utf8"));
    delete goalRun.post_execution_verification;
    delete goalRun.post_execution_convergence;
    delete goalRun.post_convergence_verification;
    goalRun.status = "blocked";
    goalRun.run_id = interruptedRunId;
    goalRun.artifact_dir = interruptedArtifactDir;
    await writeFile(goalRunPath, `${JSON.stringify(goalRun, null, 2)}\n`, "utf8");

    const output = await runRoute({ input: `resume ${interruptedRunId}`, enabled: true });

    assert.equal(output.status, "routed");
    assert.equal(output.user_report.status, "auto_resumed_verify");
    assert.ok(output.user_report.evidence_pointers.some((path) => path.endsWith("resume-lock.json")));
    assert.ok(output.user_report.evidence_pointers.some((path) => path.endsWith("auto-resume-attempt.json")));
    assert.ok(output.user_report.evidence_pointers.some((path) => path.endsWith("resume-post-execution-evidence.json")));
    assert.equal(output.result_summary?.status, "auto_resume_executed");
    assert.equal(output.result_summary?.checkpoint_phase, "verify");
    assert.equal(output.result_summary?.verification_verdict, "sufficient_evidence");
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

test("resume auto-runs convergence and re-verification from the converge checkpoint", async () => {
  const previousStateRoot = process.env.PILOT_STATE_ROOT;
  const stateRoot = await tempStateRoot();
  process.env.PILOT_STATE_ROOT = stateRoot;
  try {
    const root = await mkdtemp(join(tmpdir(), "pilot-route-converge-"));
    const requestPath = await convergenceGoalRequest(root, "route-converge-resume");
    const goal = await runGoal({
      requestPath,
      stateRoot,
      now: new Date("2026-06-01T00:05:00.000Z"),
    });
    assert.equal(goal.post_execution_verification?.verdict, "insufficient_evidence");
    assert.equal(goal.post_execution_convergence?.status, "completed");
    assert.equal(goal.post_convergence_verification?.verdict, "sufficient_evidence");

    const interrupted = await interruptedGoalRun(stateRoot, goal, "converge-checkpoint", (goalRun) => {
      delete goalRun.post_execution_convergence;
      delete goalRun.post_convergence_verification;
    });

    const output = await runRoute({ input: `resume ${interrupted.run_id}`, enabled: true });

    assert.equal(output.status, "routed");
    assert.equal(output.user_report.status, "auto_resumed_converge");
    assert.ok(output.user_report.evidence_pointers.some((path) => path.endsWith("resume-lock.json")));
    assert.ok(output.user_report.evidence_pointers.some((path) => path.endsWith("auto-resume-attempt.json")));
    assert.ok(output.user_report.evidence_pointers.some((path) => path.endsWith("post-execution-conv-request.json")));
    assert.ok(output.user_report.evidence_pointers.some((path) => path.endsWith("resume-post-convergence-evidence.json")));
    assert.equal(output.result_summary?.status, "auto_resume_executed");
    assert.equal(output.result_summary?.checkpoint_phase, "converge");
    assert.equal(output.result_summary?.convergence_status, "completed");
    assert.equal(output.result_summary?.post_convergence_verification_verdict, "sufficient_evidence");
  } finally {
    if (previousStateRoot === undefined) {
      delete process.env.PILOT_STATE_ROOT;
    } else {
      process.env.PILOT_STATE_ROOT = previousStateRoot;
    }
  }
});

test("resume auto-runs reverify from the reverify checkpoint without rerunning convergence", async () => {
  const previousStateRoot = process.env.PILOT_STATE_ROOT;
  const stateRoot = await tempStateRoot();
  process.env.PILOT_STATE_ROOT = stateRoot;
  try {
    const root = await mkdtemp(join(tmpdir(), "pilot-route-reverify-"));
    const requestPath = await convergenceGoalRequest(root, "route-reverify-resume");
    const goal = await runGoal({
      requestPath,
      stateRoot,
      now: new Date("2026-06-01T00:06:00.000Z"),
    });
    assert.equal(goal.post_execution_convergence?.status, "completed");
    assert.equal(goal.post_convergence_verification?.verdict, "sufficient_evidence");

    const interrupted = await interruptedGoalRun(stateRoot, goal, "reverify-checkpoint", (goalRun) => {
      delete goalRun.post_convergence_verification;
    });

    const output = await runRoute({ input: `resume ${interrupted.run_id}`, enabled: true });

    assert.equal(output.status, "routed");
    assert.equal(output.user_report.status, "auto_resumed_reverify");
    assert.ok(output.user_report.evidence_pointers.some((path) => path.endsWith("resume-lock.json")));
    assert.ok(output.user_report.evidence_pointers.some((path) => path.endsWith("auto-resume-attempt.json")));
    assert.ok(output.user_report.evidence_pointers.some((path) => path.endsWith("resume-post-convergence-evidence.json")));
    assert.equal(output.result_summary?.status, "auto_resume_executed");
    assert.equal(output.result_summary?.checkpoint_phase, "reverify");
    assert.equal(output.result_summary?.verification_verdict, "sufficient_evidence");
  } finally {
    if (previousStateRoot === undefined) {
      delete process.env.PILOT_STATE_ROOT;
    } else {
      process.env.PILOT_STATE_ROOT = previousStateRoot;
    }
  }
});

test("resume auto-runs standalone conv from a conv checkpoint", async () => {
  const previousStateRoot = process.env.PILOT_STATE_ROOT;
  const stateRoot = await tempStateRoot();
  process.env.PILOT_STATE_ROOT = stateRoot;
  try {
    const root = await mkdtemp(join(tmpdir(), "pilot-standalone-conv-resume-"));
    const anchorPath = join(root, "anchor.md");
    await writeFile(anchorPath, "# Standalone Conv Resume Anchor\n", "utf8");
    const runId = "20260601T001000Z-standalone-conv-resume";
    const shortId = shortRunId(runId);
    const artifactDir = join(stateRoot, "runs", runId);
    await mkdir(artifactDir, { recursive: true });
    const roundOnePath = join(artifactDir, "round-1-evidence-update.md");
    await writeFile(roundOnePath, "# Conv Evidence Update\n\nFinding: finding-one\n", "utf8");
    const request = standaloneConvRequest(anchorPath);
    const checkpoint: ConvCheckpoint = {
      schema_version: "pilot.conv_checkpoint.v0",
      run_id: runId,
      status: "running",
      request,
      findings: request.findings,
      rounds: [
        {
          round: 1,
          finding_ids: ["finding-one"],
          action_summary: "Reduced finding finding-one with a local evidence update.",
          evidence_update: roundOnePath,
          verdict: "reduced",
        },
      ],
      next_round: 2,
      max_rounds: 2,
      artifact_dir: artifactDir,
      updated_at: new Date("2026-06-01T00:10:00.000Z").toISOString(),
    };
    const requestPath = join(artifactDir, "conv-request.json");
    const checkpointPath = join(artifactDir, "conv-checkpoint.json");
    await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
    await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
    await appendRunIndexEntry(stateRoot, {
      schema_version: "pilot.run_index.v0",
      created_at: new Date("2026-06-01T00:10:00.000Z").toISOString(),
      channel: "telegram",
      chat_id: "343580315",
      sender_id: "343580315",
      source_message_id: "23345",
      source_update_id: "23345",
      command: "/conv",
      run_id: runId,
      short_run_id: shortId,
      status: "running",
      artifact_dir: artifactDir,
      next_action: `Run resume ${runId} to continue standalone /conv from the checkpoint.`,
    });
    await appendLineageRecord(stateRoot, {
      schema_version: "pilot.lineage.v0",
      created_at: new Date("2026-06-01T00:10:00.000Z").toISOString(),
      record_type: "run",
      command: "/conv",
      run_id: runId,
      short_run_id: shortId,
      status: "running",
      state_root: stateRoot,
      artifact_dir: artifactDir,
      evidence_pointers: [requestPath, checkpointPath, roundOnePath],
      receipt_pointers: [],
      resume_hint: `Run resume ${runId} to continue standalone /conv from the checkpoint.`,
      metadata: { checkpoint_path: checkpointPath, last_progress_at: new Date("2026-06-01T00:10:00.000Z").toISOString() },
    });

    const output = await runRoute({ input: `resume ${runId}`, enabled: true });

    assert.equal(output.status, "routed");
    assert.equal(output.user_report.status, "auto_resumed_conv");
    assert.ok(output.user_report.evidence_pointers.some((path) => path.endsWith("resume-lock.json")));
    assert.ok(output.user_report.evidence_pointers.some((path) => path.endsWith("auto-resume-attempt.json")));
    assert.ok(output.user_report.evidence_pointers.some((path) => path.endsWith("conv-checkpoint.json")));
    assert.equal(output.result_summary?.status, "auto_resume_executed");
    assert.equal(output.result_summary?.checkpoint_phase, "conv");
    assert.equal(output.result_summary?.convergence_status, "completed");
    assert.equal(output.result_summary?.convergence_rounds, 2);

    const conv = JSON.parse(await readFile(join(artifactDir, "conv.json"), "utf8"));
    assert.equal(conv.status, "completed");
    assert.equal(conv.rounds.length, 2);
    const updatedCheckpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    assert.equal(updatedCheckpoint.status, "completed");
    assert.equal(updatedCheckpoint.rounds.length, 2);
  } finally {
    if (previousStateRoot === undefined) {
      delete process.env.PILOT_STATE_ROOT;
    } else {
      process.env.PILOT_STATE_ROOT = previousStateRoot;
    }
  }
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
    const approvedRequest = JSON.parse(await readFile(join(plan.artifact_dir, "approved-execution-request.json"), "utf8"));
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
    const plan = await runPlan({
      request:
        "Create a tiny local dashboard prototype for reviewing Pilot receipts at /tmp/pilot-receipts-dashboard.html.",
    });
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
    const approvedRequest = JSON.parse(await readFile(join(plan.artifact_dir, "approved-execution-request.json"), "utf8"));
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
    const approvedRequest = JSON.parse(await readFile(join(plan.artifact_dir, "approved-execution-request.json"), "utf8"));
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

test("approve route executes freeform local file creation goals through the session runner", async () => {
  const previousStateRoot = process.env.PILOT_STATE_ROOT;
  const previousEnv = {
    enabled: process.env.PILOT_SESSION_RUNNER_ENABLED,
    command: process.env.PILOT_SESSION_RUNNER_COMMAND,
    args: process.env.PILOT_SESSION_RUNNER_ARGS_JSON,
    timeout: process.env.PILOT_SESSION_RUNNER_TIMEOUT_MS,
    target: process.env.PILOT_TEST_TARGET_PATH,
  };
  const stateRoot = await tempStateRoot();
  const targetPath = join(stateRoot, "workspace", "tmp", "pilot-e2e-smoke.txt");
  process.env.PILOT_STATE_ROOT = stateRoot;
  process.env.PILOT_SESSION_RUNNER_ENABLED = "true";
  process.env.PILOT_SESSION_RUNNER_COMMAND = process.execPath;
  process.env.PILOT_SESSION_RUNNER_ARGS_JSON = JSON.stringify([
    "-e",
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const target = process.env.PILOT_TEST_TARGET_PATH;",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  if (!target) process.exit(2);",
      "  if (!input.includes('do not replace it with a placeholder Pilot artifact')) process.exit(3);",
      "  fs.mkdirSync(path.dirname(target), { recursive: true });",
      "  fs.writeFileSync(target, 'pilot e2e smoke ok\\n', 'utf8');",
      "  console.log(`created ${target}`);",
      "});",
    ].join(" "),
  ]);
  process.env.PILOT_SESSION_RUNNER_TIMEOUT_MS = "5000";
  process.env.PILOT_TEST_TARGET_PATH = targetPath;
  try {
    const prompt = `Create a tiny Pilot end-to-end smoke artifact in ${targetPath} with one line: "pilot e2e smoke ok". Verify the file exists and report the evidence path.`;
    const plan = await runRoute({
      input: `/goal ${prompt}`,
      enabled: true,
      metadata: { channel: "telegram", chat_id: "343580315", sender_id: "343580315", message_id: "23360" },
    });
    assert.equal(plan.status, "routed");
    assert.equal(plan.user_report.status, "goal_plan_created");
    const shortId = plan.result_summary?.short_run_id as string;
    const planRunId = plan.result_summary?.run_id as string;
    const artifactDir = plan.result_summary?.artifact_dir as string;
    assert.ok(shortId);
    assert.ok(planRunId);
    assert.ok(artifactDir);
    await appendRunIndexEntry(stateRoot, {
      schema_version: "pilot.run_index.v0",
      created_at: new Date("2026-06-01T00:00:00.000Z").toISOString(),
      channel: "telegram",
      chat_id: "343580315",
      sender_id: "343580315",
      source_message_id: "23360",
      source_update_id: "23360",
      command: "/goal",
      run_id: planRunId,
      short_run_id: shortId,
      status: "goal_plan_created",
      artifact_dir: artifactDir,
      next_action: `Review the plan. To continue, reply "approve ${shortId}".`,
    });

    const output = await runRoute({
      input: `approve ${shortId}`,
      enabled: true,
      metadata: { channel: "telegram", chat_id: "343580315", sender_id: "343580315", message_id: "23361" },
    });

    assert.equal(output.status, "routed");
    assert.equal(output.user_report.status, "completed_verified");
    assert.ok(output.user_report.evidence_pointers.some((path) => path.endsWith("runner-result.json")));
    assert.ok(output.user_report.evidence_pointers.some((path) => path.endsWith("runner-stdout.txt")));
    assert.equal(await readFile(targetPath, "utf8"), "pilot e2e smoke ok\n");
    const approvedRequest = JSON.parse(await readFile(join(artifactDir, "approved-execution-request.json"), "utf8"));
    assert.match(approvedRequest.goal.statement, /Execute approved execution_plan/);
    assert.ok(approvedRequest.goal.statement.includes(prompt));
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
    if (previousEnv.target === undefined) delete process.env.PILOT_TEST_TARGET_PATH;
    else process.env.PILOT_TEST_TARGET_PATH = previousEnv.target;
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

test("/goal freeform route treats filesystem paths inside objectives as goal text", async () => {
  const previousStateRoot = process.env.PILOT_STATE_ROOT;
  process.env.PILOT_STATE_ROOT = await tempStateRoot();
  try {
    const output = await runRoute({
      input: String.raw`/goal Create a tiny Pilot end-to-end smoke artifact in /Users/moon/.openclaw/workspace/tmp/pilot-e2e-smoke.txt with one line: "pilot e2e smoke ok". Verify the file exists and report the evidence path.`,
      enabled: true,
      metadata: { channel: "telegram", chat_id: "343580315", sender_id: "343580315", message_id: "23453" },
    });

    assert.equal(output.status, "routed");
    assert.equal(output.command, "/goal");
    assert.equal(output.user_report.status, "goal_plan_created");
    assert.equal(output.result_summary?.mode, "goal_intake_plan");
    assert.match(output.user_report.next_action, /approve \d{6}/);
    assert.ok(output.user_report.evidence_pointers.some((path) => path.endsWith("goal.json")));
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
