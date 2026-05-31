import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRunId, eventLine, prepareRunDirectory, renderGoalRunMarkdown, writeJson } from "../artifacts.ts";
import { defaultStateRoot } from "../config.ts";
import { validateGoalRequest } from "../schema/index.ts";
import type { EventRecord, GoalRunResult, GoalStep, GoalRequest, TypedReceipt, VerificationFinding } from "../types.ts";

export type RunGoalOptions = {
  requestPath: string;
  stateRoot?: string;
  now?: Date;
};

function needsPlanSemantics(request: GoalRequest): boolean {
  return request.plan.ambiguity_questions !== undefined && request.plan.ambiguity_questions.length > 0;
}

function approvalCoversCapabilities(request: GoalRequest): boolean {
  if (!request.approval?.approved) return false;
  const approved = new Set(request.approval.approved_capabilities);
  return request.preflight.typed_capabilities.every((capability) => approved.has(capability));
}

function collectPreExecutionFindings(request: GoalRequest, validationErrors: string[]): VerificationFinding[] {
  const findings: VerificationFinding[] = validationErrors.map((message) => ({
    code: "goal_request_invalid",
    message,
    severity: "error",
  }));

  if (validationErrors.length > 0) return findings;

  if (needsPlanSemantics(request)) {
    findings.push({
      code: "goal_requires_plan_semantics",
      message: "Goal has ambiguity questions and must remain in planning before execution.",
      severity: "warning",
    });
  }

  if (!request.approval?.approved) {
    findings.push({
      code: "approval_required",
      message: "Goal execution requires explicit scoped approval.",
      severity: "warning",
    });
  } else if (!approvalCoversCapabilities(request)) {
    findings.push({
      code: "approval_scope_mismatch",
      message: "Approved capabilities do not cover the typed execution capability list.",
      severity: "error",
    });
  }

  if (request.preflight.risk_class !== "low") {
    findings.push({
      code: "explicit_high_risk_approval_required",
      message: "Medium or high-risk goals require a separate explicit approval boundary before execution.",
      severity: "error",
    });
  }

  return findings;
}

function isHardBlock(message: string): boolean {
  return message.includes("invalid goal request schema version")
    || message.includes("missing goal id")
    || message.includes("missing goal statement")
    || message.includes("invalid goal profile")
    || message.includes("missing plan")
    || message.includes("missing preflight");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function chooseStatus(findings: VerificationFinding[]): GoalRunResult["status"] {
  if (findings.some((finding) => finding.code === "goal_request_invalid" && isHardBlock(finding.message))) return "blocked";
  if (findings.some((finding) => finding.code === "goal_request_invalid")) return "needs_user_decision";
  if (findings.some((finding) => finding.code === "goal_requires_plan_semantics")) return "needs_user_decision";
  if (findings.some((finding) => finding.code === "approval_required")) return "awaiting_approval";
  if (findings.some((finding) => finding.code === "approval_scope_mismatch" || finding.code === "explicit_high_risk_approval_required")) {
    return "needs_user_decision";
  }
  return "completed";
}

export async function runGoal(options: RunGoalOptions): Promise<GoalRunResult> {
  const requestPath = resolve(options.requestPath);
  const request = JSON.parse(await readFile(requestPath, "utf8")) as GoalRequest;
  const stateRoot = options.stateRoot || defaultStateRoot();
  const now = options.now || new Date();
  const createdAt = now.toISOString();
  const runId = createRunId(`goal-${request.goal?.id || "request"}`, now);
  const artifactDir = await prepareRunDirectory(stateRoot, runId);
  const validationErrors = validateGoalRequest(request);
  const findings = collectPreExecutionFindings(request, validationErrors);
  const steps: GoalStep[] = [];
  const receipts: TypedReceipt[] = [];
  const events: EventRecord[] = [
    {
      timestamp: createdAt,
      run_id: runId,
      event: "goal_request_loaded",
      status: "ok",
      details: { request_path: requestPath },
    },
  ];

  let status = chooseStatus(findings);

  if (status === "completed") {
    const artifactPath = join(artifactDir, "step-1-goal-artifact.md");
    await writeFile(
      artifactPath,
      [
        "# Goal Execution Artifact",
        "",
        `Goal: ${request.goal.statement}`,
        "",
        "Local scoped execution completed by creating this bounded artifact.",
        "",
      ].join("\n"),
      "utf8",
    );

    steps.push({
      step: 1,
      capability: "create_artifact",
      action_summary: "Created a scoped local goal artifact.",
      artifact_path: artifactPath,
      receipt_recorded: true,
    });
    receipts.push({
      schema_version: "pilot.receipt.v0",
      action: "create_scoped_goal_artifact",
      capability: "create_artifact",
      run_id: runId,
      step: 1,
      artifact_path: artifactPath,
      status: "ok",
      scope: request.approval?.approved_scope,
      actor: "pilot.local",
      timestamp: createdAt,
      risk_class: request.preflight.risk_class,
      approval_reference: request.approval?.reference,
      primary_proof: true,
    });
    events.push({
      timestamp: createdAt,
      run_id: runId,
      event: "goal_step_completed",
      status: "ok",
      details: { capability: "create_artifact", approval_reference: request.approval?.reference },
    });

    if (await pathExists(artifactPath)) {
      findings.push({
        code: "structural_evidence_sufficient",
        message: "Approved local artifact exists and typed receipt was recorded.",
        severity: "info",
      });
      events.push({
        timestamp: createdAt,
        run_id: runId,
        event: "goal_structural_evidence_checked",
        status: "sufficient_evidence",
        details: { artifact_path: artifactPath, receipt_recorded: true },
      });
    } else {
      status = "needs_evidence";
      findings.push({
        code: "goal_artifact_missing_after_execution",
        message: "Goal artifact was expected but was not found after execution.",
        severity: "error",
      });
    }
  } else {
    events.push({
      timestamp: createdAt,
      run_id: runId,
      event: "goal_execution_not_started",
      status,
      details: { findings: findings.map((finding) => finding.code) },
    });
  }

  const files = {
    goalRun: join(artifactDir, "goal-run.json"),
    events: join(artifactDir, "events.jsonl"),
    final: join(artifactDir, "final.md"),
  };

  const createdFiles = [...Object.values(files), ...steps.map((step) => step.artifact_path)];
  const receiptsPath = join(artifactDir, "receipts.jsonl");
  if (receipts.length > 0) createdFiles.push(receiptsPath);

  const result: GoalRunResult = {
    schema_version: "pilot.goal_run.v0",
    run_id: runId,
    status,
    request,
    steps,
    findings,
    created_at: createdAt,
    artifact_dir: artifactDir,
    created_files: createdFiles,
  };

  await writeJson(files.goalRun, result);
  if (receipts.length > 0) {
    await writeFile(receiptsPath, receipts.map((receipt) => `${JSON.stringify(receipt)}\n`).join(""), "utf8");
  }
  await writeFile(files.events, events.map(eventLine).join(""), "utf8");
  await writeFile(files.final, renderGoalRunMarkdown(result), "utf8");

  return result;
}
