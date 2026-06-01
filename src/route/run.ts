import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveApprovalTarget } from "../approval/run.ts";
import { writeJson } from "../artifacts.ts";
import { resumeConvFromCheckpoint, runConv } from "../conv/run.ts";
import {
  executionPlanArtifactName,
  executionPlanCapabilities,
  executionPlanRiskClass,
  executionPlanScope,
  readExecutionPlan,
} from "../execution-plan.ts";
import {
  buildPostConvergenceEvidencePacket,
  buildPostExecutionConvRequest,
  buildPostExecutionEvidencePacket,
  fixableVerificationVerdict,
} from "../goal/post-execution.ts";
import { runGoal } from "../goal/run.ts";
import { runPlan } from "../plan/run.ts";
import { profileExpectationSummary } from "../profiles/index.ts";
import { resolveApprovalEntry } from "../state/approval-index.ts";
import {
  cancelRecoveryRun,
  createResumeDirective,
  isRecoveryRunCancelled,
  listRecoveryRuns,
  resolveRecoveryRun,
} from "../state/recovery.ts";
import { shortRunId } from "../state/run-index.ts";
import { defaultStateRoot } from "../config.ts";
import { runVerify } from "../verify/run.ts";
import type {
  CommonPlanContract,
  ConvCheckpoint,
  ConvResult,
  ExecutionPlan,
  GoalArtifact,
  GoalRequest,
  GoalRunResult,
  GoalRunStatus,
  PilotApprovalEntry,
  PilotRecoveryRunSummary,
  PilotRecoveryRunStatus,
  RouteResult,
  RouteStatus,
  RouteUserReport,
  VerificationFinding,
  VerificationResult,
} from "../types.ts";

export type RunRouteOptions = {
  input: string;
  enabled: boolean;
  metadata?: Record<string, unknown>;
};

const routeCommands = new Set(["/plan", "/verify", "/conv", "/goal", "approve", "list", "status", "resume", "cancel"]);

function userReport(
  status: string,
  evidencePointers: string[],
  remainingRisks: string[],
  nextAction: string,
  approvalPreview?: string[],
): RouteUserReport {
  const uniqueEvidencePointers = [...new Set(evidencePointers)];
  const uniqueRemainingRisks = [...new Set(remainingRisks)];
  return {
    status,
    ...(approvalPreview?.length ? { approval_preview: [...new Set(approvalPreview)] } : {}),
    evidence_pointers: uniqueEvidencePointers,
    remaining_risks: uniqueRemainingRisks.length > 0 ? uniqueRemainingRisks : ["none"],
    next_action: nextAction,
  };
}

function executionPlanApprovalPreview(plan: ExecutionPlan | undefined, shortId: string, runId: string): string[] {
  if (!plan) return [];
  const capabilities = [...new Set(plan.steps.map((step) => step.capability))].join(", ");
  const riskClasses = [...new Set(plan.steps.map((step) => step.risk_class))].join(", ");
  const expectedArtifacts = [...new Set(plan.steps.flatMap((step) => step.expected_artifacts))].slice(0, 5).join(", ");
  const milestoneCount = plan.goal_milestones?.length || 0;
  const sliceCount = plan.goal_milestones?.reduce((count, milestone) => count + milestone.slice_ids.length, 0) || 0;
  return [
    `Plan hash: ${plan.approval_subject_hash.slice(0, 12)}`,
    `Steps: ${plan.steps.length}`,
    ...(milestoneCount > 0 ? [`Goal milestones: ${milestoneCount} phases, ${sliceCount} slices`] : []),
    `Capabilities: ${capabilities || "none"}`,
    `Risk: ${riskClasses || "none"}`,
    `Expected artifacts: ${expectedArtifacts || "none"}`,
    `Command: approve ${shortId}`,
    `Full run_id: ${runId}`,
  ];
}

function planPreview(plan: CommonPlanContract): string[] {
  const phaseCount = plan.phase_plan?.length || 0;
  const sliceCount = plan.phase_plan?.reduce((count, phase) => count + phase.slices.length, 0) || 0;
  return [
    `Goal: ${plan.goal}`,
    ...(plan.outcome_summary ? [`Outcome: ${plan.outcome_summary}`] : []),
    ...(plan.context_summary?.length ? [`Context: ${plan.context_summary[0]}`] : []),
    phaseCount > 0
      ? `Phase/slice plan: ${phaseCount} goal phases, ${sliceCount} implementation slices.`
      : "Phase/slice plan: not needed for this small planning loop.",
    `Verification gates: ${plan.verification_gates.slice(0, 2).join("; ")}`,
  ];
}

async function readPlanApprovalPreview(artifactDir: string, shortId: string, runId: string): Promise<string[]> {
  try {
    return executionPlanApprovalPreview(await readExecutionPlan(join(artifactDir, executionPlanArtifactName)), shortId, runId);
  } catch {
    return [];
  }
}

function findingRisks(findings: VerificationFinding[]): string[] {
  return findings
    .filter((finding) => finding.severity !== "info")
    .map((finding) => `${finding.code}: ${finding.message}`);
}

function routeStatusFromGoalStatus(status: GoalRunStatus): RouteStatus {
  if (status === "blocked") return "blocked";
  if (status === "awaiting_approval") return "awaiting_approval";
  if (status === "needs_user_decision" || status === "needs_evidence" || status === "needs_revision") {
    return "needs_user_decision";
  }
  return "routed";
}

function goalVisibleStatus(result: GoalRunResult): string {
  return result.lifecycle?.user_status || result.status;
}

function goalNextAction(result: GoalRunResult): string {
  return result.lifecycle?.next_action || "Inspect goal-run.json and final.md before retrying.";
}

function unavailable(command: RouteResult["command"]): RouteResult {
  return {
    schema_version: "pilot.route.v0",
    status: "unavailable",
    command,
    enabled: false,
    backend: "openclaw-pilot",
    fallback_message: "Pilot exact routing is not enabled. No legacy backend was invoked.",
    user_report: userReport(
      "unavailable",
      [],
      ["Pilot exact routing is disabled."],
      "Enable Pilot exact routing before retrying this command.",
    ),
  };
}

const commandUsage: Record<"/plan" | "/verify" | "/conv" | "/goal", { usage: string; example: string; missing: string; next: string }> = {
  "/plan": {
    usage: "/plan <what to plan>",
    example: "/plan Draft a rollout plan for the Pilot Telegram smoke test.",
    missing: "Missing planning request.",
    next: "Send /plan followed by the work you want Pilot to plan.",
  },
  "/goal": {
    usage: "/goal <what to accomplish>",
    example: "/goal Create a tiny local smoke file and verify it.",
    missing: "Missing goal objective.",
    next: "Send /goal followed by a concrete objective. Pilot will plan first and wait for approval before execution.",
  },
  "/verify": {
    usage: "/verify <evidence-packet.json>",
    example: "/verify artifacts/pilot/evidence-packet.json",
    missing: "Missing evidence packet path.",
    next: "Send /verify followed by an evidence packet JSON path.",
  },
  "/conv": {
    usage: "/conv <conv-request.json>",
    example: "/conv artifacts/pilot/conv-request.json",
    missing: "Missing convergence request path.",
    next: "Send /conv followed by a convergence request JSON path.",
  },
};

function usageRoute(command: "/plan" | "/verify" | "/conv" | "/goal"): RouteResult {
  const usage = commandUsage[command];
  return {
    schema_version: "pilot.route.v0",
    status: "needs_user_decision",
    command,
    enabled: true,
    backend: "openclaw-pilot",
    result_summary: {
      status: "command_needs_input",
      usage: usage.usage,
      example: usage.example,
    },
    user_report: userReport("command_needs_input", [], [usage.missing, `Usage: ${usage.usage}`, `Example: ${usage.example}`], usage.next),
  };
}

function parseRouteInput(input: string): { command: RouteResult["command"]; rest: string } {
  const trimmed = input.trim();
  const [rawCommand, ...restParts] = trimmed.split(/\s+/);
  if (!routeCommands.has(rawCommand)) {
    throw new Error(`unsupported exact command: ${rawCommand || "(empty)"}`);
  }
  return {
    command: rawCommand as RouteResult["command"],
    rest: restParts.join(" ").trim(),
  };
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function looksLikeRunReference(value: string): boolean {
  return /^\d{6}$/.test(value) || /^\d{8}T\d{6}Z-[a-z0-9가-힣-]+$/.test(value);
}

function looksLikeGoalRequestPath(value: string): boolean {
  return /^[^\s]+\.json$/i.test(value.trim());
}

function parseRunReferenceAndReason(input: string): { reference: string; reason?: string } {
  const [reference = "", ...reasonParts] = input.trim().split(/\s+/);
  return {
    reference,
    reason: reasonParts.join(" ").trim() || undefined,
  };
}

function resumeUserReport(run: PilotRecoveryRunStatus): {
  status: string;
  risks: string[];
  nextAction: string;
  routeStatus: RouteStatus;
} {
  if (run.recovery.status === "cancelled") {
    return {
      status: "resume_blocked_cancelled",
      risks: ["Run was cancelled and will not be resumed automatically."],
      nextAction: "Create a new /plan or /goal if the work should continue.",
      routeStatus: "blocked",
    };
  }
  if (run.recovery.status === "terminal") {
    return {
      status: "resume_not_needed",
      risks: ["Run is already terminal."],
      nextAction: "Use status <Run> to inspect artifacts, or create a new /plan for new work.",
      routeStatus: "routed",
    };
  }
  if (run.recovery.status === "stale") {
    return {
      status: "resume_needs_recovery_decision",
      risks: [run.recovery.hint, "Resume command is advisory in this slice; no execution was performed."],
      nextAction:
        "Inspect status output, then choose one: cancel <Run>, start a new /plan or /goal, or manually continue from the recorded artifact directory.",
      routeStatus: "needs_user_decision",
    };
  }
  if (run.lifecycle?.next_action) {
    return {
      status: "resume_ready",
      risks: ["Resume command is advisory in this slice; no execution was performed."],
      nextAction: run.lifecycle.next_action,
      routeStatus: "routed",
    };
  }
  return {
    status: "resume_ready",
    risks: ["Resume command is advisory in this slice; no execution was performed."],
    nextAction: run.resume_hint,
    routeStatus: "routed",
  };
}

function recoveryStatusRisks(run: PilotRecoveryRunStatus): string[] {
  if (run.status === "blocked") return ["Run is blocked; inspect final.md and lineage before resuming."];
  if (run.recovery.status === "stale") return [run.recovery.hint];
  return ["none"];
}

function recoveryCandidateLine(command: "status" | "resume" | "cancel", run: PilotRecoveryRunSummary): string {
  return [
    `short=${run.short_run_id}`,
    `status=${run.status}`,
    `command=${run.command}`,
    `created=${run.created_at}`,
    `retry="${command} ${run.run_id}"`,
    `artifact_dir=${run.artifact_dir}`,
  ].join(" ");
}

function ambiguousRecoveryReport(
  command: "status" | "resume" | "cancel",
  reportStatus: string,
  reference: string,
  matches: PilotRecoveryRunSummary[],
): RouteUserReport {
  const example = matches[0]?.run_id ? `${command} ${matches[0].run_id}` : `${command} <full-run-id>`;
  return userReport(
    reportStatus,
    matches.map((run) => recoveryCandidateLine(command, run)),
    [
      `Run reference ${reference} matched ${matches.length} Pilot runs.`,
      "Short run ids are time handles and can collide; use a full run_id or a longer exact reference.",
    ],
    `Retry with one full run_id, for example: ${example}.`,
  );
}

type ResumeCheckpointPhase =
  | "approve"
  | "execute"
  | "verify"
  | "conv"
  | "converge"
  | "reverify"
  | "report"
  | "terminal"
  | "blocked";

type ResumeCheckpoint = {
  phase: ResumeCheckpointPhase;
  resumable: boolean;
  reason: string;
  request_path?: string;
  goal_run?: GoalRunResult;
  conv_checkpoint_path?: string;
  conv_checkpoint?: ConvCheckpoint;
};

function checkpointSummary(checkpoint: ResumeCheckpoint): Record<string, unknown> {
  return {
    phase: checkpoint.phase,
    resumable: checkpoint.resumable,
    reason: checkpoint.reason,
    request_path: checkpoint.request_path,
    goal_run_id: checkpoint.goal_run?.run_id,
    goal_run_status: checkpoint.goal_run?.status,
    goal_run_steps: checkpoint.goal_run?.steps.length,
    conv_checkpoint_path: checkpoint.conv_checkpoint_path,
    conv_checkpoint_status: checkpoint.conv_checkpoint?.status,
    conv_next_round: checkpoint.conv_checkpoint?.next_round,
  };
}

async function readGoalRunIfExists(artifactDir: string): Promise<GoalRunResult | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(artifactDir, "goal-run.json"), "utf8")) as GoalRunResult;
    return parsed.schema_version === "pilot.goal_run.v0" ? parsed : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readVerificationResultIfExists(artifactDir: string): Promise<VerificationResult | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(artifactDir, "verification.json"), "utf8")) as VerificationResult;
    return parsed.schema_version === "pilot.verification.v0" ? parsed : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readConvResultIfExists(artifactDir: string): Promise<ConvResult | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(artifactDir, "conv.json"), "utf8")) as ConvResult;
    return parsed.schema_version === "pilot.conv.v0" ? parsed : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readConvCheckpointIfExists(artifactDir: string): Promise<ConvCheckpoint | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(artifactDir, "conv-checkpoint.json"), "utf8")) as ConvCheckpoint;
    return parsed.schema_version === "pilot.conv_checkpoint.v0" ? parsed : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeResumeLock(run: PilotRecoveryRunStatus, checkpoint: ResumeCheckpoint): Promise<
  | { status: "locked"; lock_path: string }
  | { status: "duplicate"; lock_path: string; reason: string }
> {
  const lockPath = join(run.artifact_dir, "resume-lock.json");
  try {
    await writeFile(
      lockPath,
      `${JSON.stringify(
        {
          schema_version: "pilot.recovery_resume_lock.v0",
          created_at: new Date().toISOString(),
          run_id: run.run_id,
          short_run_id: run.short_run_id,
          checkpoint_phase: checkpoint.phase,
          status: "locked",
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    return { status: "locked", lock_path: lockPath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return {
      status: "duplicate",
      lock_path: lockPath,
      reason: "An auto-resume lock already exists for this run. Inspect resume-lock.json before retrying.",
    };
  }
}

async function resolveResumeCheckpoint(stateRoot: string, run: PilotRecoveryRunStatus): Promise<ResumeCheckpoint> {
  if (run.recovery.status === "cancelled") {
    return { phase: "blocked", resumable: false, reason: "Run is cancelled." };
  }
  if (run.recovery.status === "terminal") {
    return { phase: "terminal", resumable: false, reason: "Run is already terminal." };
  }

  const goalRun = await readGoalRunIfExists(run.artifact_dir);
  if (goalRun) {
    if (goalRun.status === "completed") {
      return { phase: "terminal", resumable: false, reason: "Goal run is already completed.", goal_run: goalRun };
    }
    if (!goalRun.request.approval?.approved) {
      return { phase: "approve", resumable: false, reason: "Goal run still needs approval.", goal_run: goalRun };
    }
    if (goalRun.steps.length === 0) {
      const requestPath = join(run.artifact_dir, "auto-resume-goal-request.json");
      await writeJson(requestPath, goalRun.request);
      return {
        phase: "execute",
        resumable: true,
        reason: "Approved goal has no completed execution step; resume can restart from execute.",
        request_path: requestPath,
        goal_run: goalRun,
      };
    }
    if (!goalRun.post_execution_verification) {
      return {
        phase: "verify",
        resumable: true,
        reason: "Execution step exists and post-execution verification is missing; resume can restart from verify.",
        goal_run: goalRun,
      };
    }
    if (
      goalRun.post_execution_verification.verdict !== "sufficient_evidence" &&
      !goalRun.post_execution_convergence
    ) {
      const verification = await readVerificationResultIfExists(goalRun.post_execution_verification.artifact_dir);
      if (!verification) {
        return {
          phase: "converge",
          resumable: false,
          reason: "Convergence checkpoint is detected, but verification.json is missing.",
          goal_run: goalRun,
        };
      }
      if (!fixableVerificationVerdict(verification)) {
        return {
          phase: "converge",
          resumable: false,
          reason: "Convergence checkpoint is detected, but the verification verdict is not fixable automatically.",
          goal_run: goalRun,
        };
      }
      return {
        phase: "converge",
        resumable: true,
        reason: "Post-execution verification has fixable findings; resume can restart from converge.",
        goal_run: goalRun,
      };
    }
    if (goalRun.post_execution_convergence?.status === "completed" && !goalRun.post_convergence_verification) {
      return {
        phase: "reverify",
        resumable: true,
        reason: "Convergence completed and post-convergence verification is missing; resume can restart from reverify.",
        goal_run: goalRun,
      };
    }
    return {
      phase: "blocked",
      resumable: false,
      reason: "Run has findings that require user decision or a narrower follow-up resume slice.",
      goal_run: goalRun,
    };
  }

  const convCheckpoint = await readConvCheckpointIfExists(run.artifact_dir);
  if (convCheckpoint) {
    const checkpointPath = join(run.artifact_dir, "conv-checkpoint.json");
    const hasOpenFindings = convCheckpoint.findings.some((finding) => finding.status === "open");
    if (convCheckpoint.status === "completed" || !hasOpenFindings) {
      return {
        phase: "terminal",
        resumable: false,
        reason: "Standalone conv checkpoint is already completed.",
        conv_checkpoint_path: checkpointPath,
        conv_checkpoint: convCheckpoint,
      };
    }
    if (convCheckpoint.next_round > convCheckpoint.max_rounds) {
      return {
        phase: "blocked",
        resumable: false,
        reason: "Standalone conv checkpoint reached the max round limit.",
        conv_checkpoint_path: checkpointPath,
        conv_checkpoint: convCheckpoint,
      };
    }
    return {
      phase: "conv",
      resumable: true,
      reason: "Standalone conv has an unfinished checkpoint; resume can continue from the next convergence round.",
      conv_checkpoint_path: checkpointPath,
      conv_checkpoint: convCheckpoint,
    };
  }

  const approval = await resolveApprovalEntry(stateRoot, run.run_id);
  if (approval.status === "found") {
    const requestPath = await writeApprovedExecutionRequest(approval.entry, undefined);
    return {
      phase: "execute",
      resumable: true,
      reason: "Approved plan has no goal execution run yet; resume can start from execute.",
      request_path: requestPath,
    };
  }

  return {
    phase: "approve",
    resumable: false,
    reason: "Plan exists but no scoped approval record was found. Ask for approve <Run> first.",
  };
}

async function runAutoResume(
  stateRoot: string,
  run: PilotRecoveryRunStatus,
  checkpoint: ResumeCheckpoint,
): Promise<
  | {
      status: "executed";
      phase: ResumeCheckpointPhase;
      attempt_artifact: string;
      lock_artifact: string;
      evidence_pointers: string[];
      result_summary: Record<string, unknown>;
      next_action: string;
    }
  | { status: "blocked"; phase: ResumeCheckpointPhase; reason: string; evidence_pointers: string[]; next_action: string }
> {
  if (!checkpoint.resumable) {
    return {
      status: "blocked",
      phase: checkpoint.phase,
      reason: checkpoint.reason,
      evidence_pointers: [],
      next_action: checkpoint.phase === "approve" ? `Run approve ${run.short_run_id} first.` : "Inspect status output before retrying resume.",
    };
  }

  const lock = await writeResumeLock(run, checkpoint);
  if (lock.status === "duplicate") {
    return {
      status: "blocked",
      phase: checkpoint.phase,
      reason: lock.reason,
      evidence_pointers: [lock.lock_path],
      next_action: "Inspect resume-lock.json and the latest status before retrying.",
    };
  }

  const attemptArtifact = join(run.artifact_dir, "auto-resume-attempt.json");
  if (checkpoint.phase === "execute") {
    if (!checkpoint.request_path) {
      return {
        status: "blocked",
        phase: checkpoint.phase,
        reason: "Execute checkpoint did not produce a goal request path.",
        evidence_pointers: [lock.lock_path],
        next_action: "Inspect resume.json and goal-run.json before retrying.",
      };
    }
    const goalResult = await runGoal({ requestPath: checkpoint.request_path, stateRoot });
    await writeJson(attemptArtifact, {
      schema_version: "pilot.recovery_auto_resume_attempt.v0",
      created_at: new Date().toISOString(),
      source_run_id: run.run_id,
      source_short_run_id: run.short_run_id,
      checkpoint_phase: checkpoint.phase,
      status: "executed",
      resumed_run_id: goalResult.run_id,
      resumed_artifact_dir: goalResult.artifact_dir,
      resumed_status: goalResult.status,
      lifecycle: goalResult.lifecycle,
      created_files: goalResult.created_files,
    });
    return {
      status: "executed",
      phase: checkpoint.phase,
      attempt_artifact: attemptArtifact,
      lock_artifact: lock.lock_path,
      evidence_pointers: [lock.lock_path, attemptArtifact, ...goalResult.created_files],
      result_summary: {
        auto_resume_status: "executed",
        checkpoint_phase: checkpoint.phase,
        resumed_run_id: goalResult.run_id,
        resumed_status: goalResult.status,
        lifecycle: goalResult.lifecycle,
      },
      next_action: goalNextAction(goalResult),
    };
  }

  if (checkpoint.phase === "verify" && checkpoint.goal_run) {
    const receiptsPath = join(checkpoint.goal_run.artifact_dir, "receipts.jsonl");
    const packetPath = join(checkpoint.goal_run.artifact_dir, "resume-post-execution-evidence.json");
    await writeJson(
      packetPath,
      buildPostExecutionEvidencePacket(
        checkpoint.goal_run.request,
        checkpoint.goal_run.run_id,
        checkpoint.goal_run.steps,
        receiptsPath,
      ),
    );
    const verification = await runVerify({ packetPath, stateRoot });
    await writeJson(attemptArtifact, {
      schema_version: "pilot.recovery_auto_resume_attempt.v0",
      created_at: new Date().toISOString(),
      source_run_id: run.run_id,
      source_short_run_id: run.short_run_id,
      checkpoint_phase: checkpoint.phase,
      status: "executed",
      verification_run_id: verification.run_id,
      verification_verdict: verification.verdict,
      verification_artifact_dir: verification.artifact_dir,
      packet_path: packetPath,
      created_files: verification.created_files,
    });
    return {
      status: "executed",
      phase: checkpoint.phase,
      attempt_artifact: attemptArtifact,
      lock_artifact: lock.lock_path,
      evidence_pointers: [lock.lock_path, attemptArtifact, packetPath, ...verification.created_files],
      result_summary: {
        auto_resume_status: "executed",
        checkpoint_phase: checkpoint.phase,
        verification_run_id: verification.run_id,
        verification_verdict: verification.verdict,
      },
      next_action:
        verification.verdict === "sufficient_evidence"
          ? "Use verification artifacts as proof, then inspect status before closing the run."
          : "Use the verification findings to run /conv or create a narrower follow-up plan.",
    };
  }

  if (checkpoint.phase === "conv" && checkpoint.conv_checkpoint_path) {
    const convergence = await resumeConvFromCheckpoint({ checkpointPath: checkpoint.conv_checkpoint_path, stateRoot });
    await writeJson(attemptArtifact, {
      schema_version: "pilot.recovery_auto_resume_attempt.v0",
      created_at: new Date().toISOString(),
      source_run_id: run.run_id,
      source_short_run_id: run.short_run_id,
      checkpoint_phase: checkpoint.phase,
      status: "executed",
      conv_checkpoint_path: checkpoint.conv_checkpoint_path,
      convergence_run_id: convergence.run_id,
      convergence_status: convergence.status,
      convergence_artifact_dir: convergence.artifact_dir,
      convergence_rounds: convergence.rounds.length,
      created_files: convergence.created_files,
    });
    return {
      status: "executed",
      phase: checkpoint.phase,
      attempt_artifact: attemptArtifact,
      lock_artifact: lock.lock_path,
      evidence_pointers: [lock.lock_path, attemptArtifact, checkpoint.conv_checkpoint_path, ...convergence.created_files],
      result_summary: {
        auto_resume_status: "executed",
        checkpoint_phase: checkpoint.phase,
        convergence_run_id: convergence.run_id,
        convergence_status: convergence.status,
        convergence_rounds: convergence.rounds.length,
      },
      next_action:
        convergence.status === "completed"
          ? "Use convergence artifacts as updated evidence, then run /verify if a final verdict is needed."
          : "Inspect conv.json and conv-checkpoint.json before retrying resume.",
    };
  }

  if (checkpoint.phase === "converge" && checkpoint.goal_run?.post_execution_verification) {
    const goalRun = checkpoint.goal_run;
    const postExecutionVerification = goalRun.post_execution_verification!;
    const verification = await readVerificationResultIfExists(postExecutionVerification.artifact_dir);
    if (!verification) {
      return {
        status: "blocked",
        phase: checkpoint.phase,
        reason: "Post-execution verification artifact is missing verification.json.",
        evidence_pointers: [lock.lock_path],
        next_action: "Inspect the verification artifact directory before retrying resume.",
      };
    }
    if (!fixableVerificationVerdict(verification)) {
      return {
        status: "blocked",
        phase: checkpoint.phase,
        reason: "Post-execution verification verdict is not fixable by bounded convergence.",
        evidence_pointers: [lock.lock_path],
        next_action: "Inspect verification findings and create a narrower follow-up plan if needed.",
      };
    }

    const receiptsPath = join(goalRun.artifact_dir, "receipts.jsonl");
    const postExecutionEvidencePath =
      postExecutionVerification.evidence_packet_path ||
      join(goalRun.artifact_dir, "resume-post-execution-evidence.json");
    const convRequest = buildPostExecutionConvRequest(
      goalRun.request,
      goalRun.run_id,
      postExecutionEvidencePath,
      verification,
    );
    if (!convRequest) {
      return {
        status: "blocked",
        phase: checkpoint.phase,
        reason: "Post-execution verification has no actionable convergence findings.",
        evidence_pointers: [lock.lock_path, postExecutionEvidencePath],
        next_action: "Inspect verification findings and create a narrower follow-up plan if needed.",
      };
    }

    const convRequestPath = join(goalRun.artifact_dir, "post-execution-conv-request.json");
    await writeJson(convRequestPath, convRequest);
    const convergence = await runConv({ requestPath: convRequestPath, stateRoot });
    let postConvergenceEvidencePath: string | undefined;
    let reverify: VerificationResult | undefined;
    if (convergence.status === "completed") {
      postConvergenceEvidencePath = join(goalRun.artifact_dir, "resume-post-convergence-evidence.json");
      await writeJson(
        postConvergenceEvidencePath,
        buildPostConvergenceEvidencePacket(goalRun.request, goalRun.run_id, goalRun.steps, receiptsPath, convergence),
      );
      reverify = await runVerify({ packetPath: postConvergenceEvidencePath, stateRoot });
    }

    await writeJson(attemptArtifact, {
      schema_version: "pilot.recovery_auto_resume_attempt.v0",
      created_at: new Date().toISOString(),
      source_run_id: run.run_id,
      source_short_run_id: run.short_run_id,
      checkpoint_phase: checkpoint.phase,
      status: "executed",
      conv_request_path: convRequestPath,
      convergence_run_id: convergence.run_id,
      convergence_status: convergence.status,
      convergence_artifact_dir: convergence.artifact_dir,
      convergence_rounds: convergence.rounds.length,
      post_convergence_evidence_path: postConvergenceEvidencePath,
      post_convergence_verification_run_id: reverify?.run_id,
      post_convergence_verification_verdict: reverify?.verdict,
      post_convergence_verification_artifact_dir: reverify?.artifact_dir,
      created_files: [
        convRequestPath,
        ...convergence.created_files,
        ...(postConvergenceEvidencePath ? [postConvergenceEvidencePath] : []),
        ...(reverify?.created_files || []),
      ],
    });

    return {
      status: "executed",
      phase: checkpoint.phase,
      attempt_artifact: attemptArtifact,
      lock_artifact: lock.lock_path,
      evidence_pointers: [
        lock.lock_path,
        attemptArtifact,
        convRequestPath,
        ...convergence.created_files,
        ...(postConvergenceEvidencePath ? [postConvergenceEvidencePath] : []),
        ...(reverify?.created_files || []),
      ],
      result_summary: {
        auto_resume_status: "executed",
        checkpoint_phase: checkpoint.phase,
        convergence_run_id: convergence.run_id,
        convergence_status: convergence.status,
        convergence_rounds: convergence.rounds.length,
        post_convergence_verification_run_id: reverify?.run_id,
        post_convergence_verification_verdict: reverify?.verdict,
      },
      next_action:
        reverify?.verdict === "sufficient_evidence"
          ? "Use convergence and re-verification artifacts as proof, then inspect status before closing the run."
          : convergence.status === "completed"
            ? "Inspect post-convergence verification findings before retrying resume."
            : "Inspect convergence findings before retrying resume.",
    };
  }

  if (checkpoint.phase === "reverify" && checkpoint.goal_run?.post_execution_convergence) {
    const goalRun = checkpoint.goal_run;
    const postExecutionConvergence = goalRun.post_execution_convergence!;
    const convergence = await readConvResultIfExists(postExecutionConvergence.artifact_dir);
    if (!convergence) {
      return {
        status: "blocked",
        phase: checkpoint.phase,
        reason: "Post-execution convergence artifact is missing conv.json.",
        evidence_pointers: [lock.lock_path],
        next_action: "Inspect the convergence artifact directory before retrying resume.",
      };
    }

    const receiptsPath = join(goalRun.artifact_dir, "receipts.jsonl");
    const packetPath = join(goalRun.artifact_dir, "resume-post-convergence-evidence.json");
    await writeJson(
      packetPath,
      buildPostConvergenceEvidencePacket(goalRun.request, goalRun.run_id, goalRun.steps, receiptsPath, convergence),
    );
    const verification = await runVerify({ packetPath, stateRoot });
    await writeJson(attemptArtifact, {
      schema_version: "pilot.recovery_auto_resume_attempt.v0",
      created_at: new Date().toISOString(),
      source_run_id: run.run_id,
      source_short_run_id: run.short_run_id,
      checkpoint_phase: checkpoint.phase,
      status: "executed",
      verification_run_id: verification.run_id,
      verification_verdict: verification.verdict,
      verification_artifact_dir: verification.artifact_dir,
      packet_path: packetPath,
      created_files: verification.created_files,
    });
    return {
      status: "executed",
      phase: checkpoint.phase,
      attempt_artifact: attemptArtifact,
      lock_artifact: lock.lock_path,
      evidence_pointers: [lock.lock_path, attemptArtifact, packetPath, ...verification.created_files],
      result_summary: {
        auto_resume_status: "executed",
        checkpoint_phase: checkpoint.phase,
        verification_run_id: verification.run_id,
        verification_verdict: verification.verdict,
      },
      next_action:
        verification.verdict === "sufficient_evidence"
          ? "Use re-verification artifacts as proof, then inspect status before closing the run."
          : "Inspect post-convergence verification findings before retrying resume.",
    };
  }

  return {
    status: "blocked",
    phase: checkpoint.phase,
    reason: `Checkpoint ${checkpoint.phase} is not automatically executable in this v1 slice.`,
    evidence_pointers: [lock.lock_path],
    next_action: "Inspect status output before retrying resume.",
  };
}

async function readPlanGoal(entry: PilotApprovalEntry): Promise<GoalArtifact> {
  const parsed = JSON.parse(await readFile(join(entry.artifact_dir, "goal.json"), "utf8")) as GoalArtifact;
  if (parsed.schema_version !== "pilot.goal.v0") throw new Error("approved plan goal artifact is invalid");
  if (parsed.run_id !== entry.run_id) throw new Error("approved plan goal artifact does not match approval run");
  if (parsed.status !== "completed_plan") throw new Error(`approved plan is not executable: ${parsed.status}`);
  return parsed;
}

function assertApprovalScope(entry: PilotApprovalEntry, metadata: Record<string, unknown> | undefined): string[] {
  const risks: string[] = [];
  const chatId = metadataString(metadata, "chat_id");
  const senderId = metadataString(metadata, "sender_id");
  if (entry.chat_id && chatId && entry.chat_id !== chatId) {
    risks.push(`Approval chat mismatch: expected ${entry.chat_id}.`);
  }
  if (entry.sender_id && senderId && entry.sender_id !== senderId) {
    risks.push(`Approval sender mismatch: expected ${entry.sender_id}.`);
  }
  return risks;
}

function approvedPlanContract(entry: PilotApprovalEntry, goal: GoalArtifact, capabilities: string[], scope: string[]): CommonPlanContract {
  return {
    goal: `Execute approved execution_plan for Pilot plan run ${entry.short_run_id}.`,
    scope,
    out_of_scope: [
      "Actions outside the approved execution_plan.",
      "Capabilities not listed in execution_plan.steps.",
      "External public posts, third-party messages, payments, credential access, deploys, releases, restarts, or merges unless a new approved execution_plan explicitly authorizes them.",
    ],
    success_criteria: [
      "A new local goal-run artifact directory exists.",
      "Only execution_plan.steps are executed.",
      "Typed receipts record execution_step_id for every completed step.",
      `The execution references approved plan run ${entry.run_id}.`,
    ],
    risks_assumptions: [
      "execution_plan is the single authorization object.",
      "plan.md is explanatory and cannot authorize execution by prose.",
      `Original request: ${goal.request}`,
    ],
    action_boundaries: {
      allowed_actions: capabilities,
      approval_required_actions: ["execute only the approved execution_plan steps"],
      disallowed_actions: ["out_of_plan_action", "vague_broad_authority", "unreported_external_action"],
    },
    verification_gates: [
      "goal-run.json exists",
      "receipts.jsonl contains pilot.receipt.v0 with execution_step_id",
      `approval reference equals ${entry.run_id}`,
      `execution_plan hash equals ${entry.execution_plan_hash || "missing"}`,
    ],
    next_recommended_step: "Inspect goal-run.json, receipts, and final.md.",
  };
}

async function writeApprovedExecutionRequest(entry: PilotApprovalEntry, metadata: Record<string, unknown> | undefined): Promise<string> {
  const scopeRisks = assertApprovalScope(entry, metadata);
  if (scopeRisks.length > 0) throw new Error(scopeRisks.join(" "));
  const goal = await readPlanGoal(entry);
  const executionPlanPath = entry.execution_plan_ref || join(entry.artifact_dir, executionPlanArtifactName);
  const executionPlan = await readExecutionPlan(executionPlanPath);
  if (!entry.execution_plan_hash || executionPlan.approval_subject_hash !== entry.execution_plan_hash) {
    throw new Error("approved execution_plan hash mismatch");
  }
  const capabilities = executionPlanCapabilities(executionPlan);
  const scope = executionPlanScope(executionPlan);
  const riskClass = executionPlanRiskClass(executionPlan);
  const request: GoalRequest = {
    schema_version: "pilot.goal_request.v0",
    goal: {
      id: `approved-${entry.short_run_id}`,
      statement: `Execute approved execution_plan for Pilot plan run ${entry.short_run_id}: ${goal.request}`,
      profile: goal.profile,
    },
    plan: approvedPlanContract(entry, goal, capabilities, scope),
    approval: {
      reference: entry.run_id,
      approved: true,
      approved_scope: scope,
      approved_capabilities: capabilities,
      execution_plan_ref: executionPlanPath,
      execution_plan_hash: entry.execution_plan_hash,
    },
    preflight: {
      risk_class: riskClass,
      typed_capabilities: capabilities,
      dangerous_action_gates: [
        "external_message",
        "payment",
        "credential_access",
        "server_restart",
        "destructive_filesystem",
        "deploy",
        "pr_merge",
        "release",
      ],
      receipt_required: true,
      max_rounds: 1,
      stop_conditions: ["success_criteria_met", "approval_boundary_hit"],
    },
    execution_plan: executionPlan,
  };
  const requestPath = join(entry.artifact_dir, "approved-execution-request.json");
  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  return requestPath;
}

export async function runRoute(options: RunRouteOptions): Promise<RouteResult> {
  const parsed = parseRouteInput(options.input);

  if (!options.enabled) return unavailable(parsed.command);

  if (parsed.command === "list") {
    const limitText = parsed.rest.match(/\d+/)?.[0];
    const limit = limitText ? Math.min(Math.max(Number(limitText), 1), 25) : 10;
    const runs = await listRecoveryRuns(defaultStateRoot(), limit);
    return {
      schema_version: "pilot.route.v0",
      status: "routed",
      command: parsed.command,
      enabled: true,
      backend: "openclaw-pilot",
      result_summary: {
        status: "recovery_list",
        count: runs.length,
        runs,
      },
      user_report: userReport(
        "recovery_list",
        runs.map((run) => `${run.short_run_id} ${run.status} ${run.run_id} ${run.artifact_dir}`),
        runs.length === 0
          ? ["No Pilot runs found in the current state root."]
          : runs.some((run) => run.recovery.status === "stale")
            ? ["One or more Pilot runs are stale; use status <Run> or resume <Run> for recovery guidance."]
            : ["none"],
        runs.length === 0
          ? "Run /plan or /goal first, then retry list."
          : `Reply "status ${runs[0].short_run_id}" to inspect the newest Pilot run.`,
      ),
    };
  }

  if (parsed.command === "status") {
    if (!parsed.rest) throw new Error("route status requires a run reference");
    const resolution = await resolveRecoveryRun(defaultStateRoot(), parsed.rest);
    if (resolution.status === "not_found") {
      return {
        schema_version: "pilot.route.v0",
        status: "needs_user_decision",
        command: parsed.command,
        enabled: true,
        backend: "openclaw-pilot",
        result_summary: { status: "recovery_not_found", reference: resolution.reference },
        user_report: userReport(
          "recovery_not_found",
          [],
          [`No Pilot run matched status reference: ${resolution.reference}.`],
          "Run list to find recent Pilot runs, then retry status with a short or full run id.",
        ),
      };
    }
    if (resolution.status === "ambiguous") {
      return {
        schema_version: "pilot.route.v0",
        status: "needs_user_decision",
        command: parsed.command,
        enabled: true,
        backend: "openclaw-pilot",
        result_summary: {
          status: "recovery_ambiguous",
          reference: resolution.reference,
          matches: resolution.matches,
        },
        user_report: ambiguousRecoveryReport("status", "recovery_ambiguous", resolution.reference, resolution.matches),
      };
    }
    const run = resolution.run;
    return {
      schema_version: "pilot.route.v0",
      status: run.status === "blocked" ? "blocked" : "routed",
      command: parsed.command,
      enabled: true,
      backend: "openclaw-pilot",
      result_summary: {
        status: "recovery_status",
        run,
      },
      user_report: userReport(
        run.lifecycle?.user_status || run.status,
        [...run.available_artifacts, ...run.evidence_pointers, ...run.receipt_pointers],
        recoveryStatusRisks(run),
        run.lifecycle?.next_action || run.resume_hint,
      ),
    };
  }

  if (parsed.command === "resume") {
    if (!parsed.rest) throw new Error("route resume requires a run reference");
    const resolution = await resolveRecoveryRun(defaultStateRoot(), parsed.rest);
    if (resolution.status === "not_found") {
      return {
        schema_version: "pilot.route.v0",
        status: "needs_user_decision",
        command: parsed.command,
        enabled: true,
        backend: "openclaw-pilot",
        result_summary: { status: "recovery_resume_not_found", reference: resolution.reference },
        user_report: userReport(
          "recovery_resume_not_found",
          [],
          [`No Pilot run matched resume reference: ${resolution.reference}.`],
          "Run list to find recent Pilot runs, then retry resume with a short or full run id.",
        ),
      };
    }
    if (resolution.status === "ambiguous") {
      return {
        schema_version: "pilot.route.v0",
        status: "needs_user_decision",
        command: parsed.command,
        enabled: true,
        backend: "openclaw-pilot",
        result_summary: {
          status: "recovery_resume_ambiguous",
          reference: resolution.reference,
          matches: resolution.matches,
        },
        user_report: ambiguousRecoveryReport("resume", "recovery_resume_ambiguous", resolution.reference, resolution.matches),
      };
    }
    const run = resolution.run;
    const resume = resumeUserReport(run);
    const checkpoint = await resolveResumeCheckpoint(defaultStateRoot(), run);
    const directive = await createResumeDirective(defaultStateRoot(), run, {
      nextAction: checkpoint.resumable ? `Auto-resume from ${checkpoint.phase}.` : resume.nextAction,
      risks: [...resume.risks, checkpoint.reason],
      metadata: { ...(options.metadata || {}), checkpoint_phase: checkpoint.phase, checkpoint_resumable: String(checkpoint.resumable) },
    });
    const reportRun = directive.status === "created" ? directive.run : run;
    const directiveArtifacts = directive.status === "created" ? [directive.resume_artifact] : [];
    const autoResume = directive.status === "created"
      ? await runAutoResume(defaultStateRoot(), reportRun, checkpoint)
      : {
          status: "blocked" as const,
          phase: checkpoint.phase,
          reason: directive.reason,
          evidence_pointers: [],
          next_action: resume.nextAction,
        };
    const autoResumeRisks =
      autoResume.status === "executed"
        ? ["none"]
        : [...resume.risks, autoResume.reason];
    return {
      schema_version: "pilot.route.v0",
      status: autoResume.status === "executed" ? "routed" : resume.routeStatus === "routed" ? "needs_user_decision" : resume.routeStatus,
      command: parsed.command,
      enabled: true,
      backend: "openclaw-pilot",
      result_summary: {
        status: autoResume.status === "executed" ? "auto_resume_executed" : resume.status,
        run: reportRun,
        checkpoint: checkpointSummary(checkpoint),
        auto_resume: autoResume,
        resume_artifact: directive.status === "created" ? directive.resume_artifact : undefined,
        resume_artifact_status: directive.status,
        ...(autoResume.status === "executed" ? autoResume.result_summary : {}),
      },
      user_report: userReport(
        autoResume.status === "executed" ? `auto_resumed_${autoResume.phase}` : resume.status,
        [
          ...directiveArtifacts,
          ...autoResume.evidence_pointers,
          ...reportRun.available_artifacts,
          ...reportRun.evidence_pointers,
          ...reportRun.receipt_pointers,
        ],
        directive.status === "not_resumable" ? [...autoResumeRisks, directive.reason] : autoResumeRisks,
        autoResume.next_action,
      ),
    };
  }

  if (parsed.command === "cancel") {
    const { reference, reason } = parseRunReferenceAndReason(parsed.rest);
    if (!reference) throw new Error("route cancel requires a run reference");
    const cancellation = await cancelRecoveryRun(defaultStateRoot(), reference, { reason, metadata: options.metadata });
    if (cancellation.status === "not_found") {
      return {
        schema_version: "pilot.route.v0",
        status: "needs_user_decision",
        command: parsed.command,
        enabled: true,
        backend: "openclaw-pilot",
        result_summary: { status: "recovery_cancel_not_found", reference: cancellation.reference },
        user_report: userReport(
          "recovery_cancel_not_found",
          [],
          [`No Pilot run matched cancel reference: ${cancellation.reference}.`],
          "Run list to find recent Pilot runs, then retry cancel with a short or full run id.",
        ),
      };
    }
    if (cancellation.status === "ambiguous") {
      return {
        schema_version: "pilot.route.v0",
        status: "needs_user_decision",
        command: parsed.command,
        enabled: true,
        backend: "openclaw-pilot",
        result_summary: {
          status: "recovery_cancel_ambiguous",
          reference: cancellation.reference,
          matches: cancellation.matches,
        },
        user_report: ambiguousRecoveryReport("cancel", "recovery_cancel_ambiguous", cancellation.reference, cancellation.matches),
      };
    }
    if (cancellation.status === "not_cancelable") {
      return {
        schema_version: "pilot.route.v0",
        status: "needs_user_decision",
        command: parsed.command,
        enabled: true,
        backend: "openclaw-pilot",
        result_summary: {
          status: "recovery_cancel_not_cancelable",
          reason: cancellation.reason,
          run: cancellation.run,
        },
        user_report: userReport(
          "recovery_cancel_not_cancelable",
          cancellation.run.available_artifacts,
          [cancellation.reason],
          "Use status <Run> to inspect the terminal run, or create a new /plan for new work.",
        ),
      };
    }
    const run = cancellation.run;
    const evidence =
      cancellation.status === "cancelled"
        ? [cancellation.cancel_artifact, ...run.available_artifacts]
        : run.available_artifacts;
    return {
      schema_version: "pilot.route.v0",
      status: "routed",
      command: parsed.command,
      enabled: true,
      backend: "openclaw-pilot",
      result_summary: {
        status: cancellation.status,
        run,
        previous_status: cancellation.status === "cancelled" ? cancellation.previous_status : undefined,
        cancel_artifact: cancellation.status === "cancelled" ? cancellation.cancel_artifact : undefined,
      },
      user_report: userReport(
        cancellation.status === "already_cancelled" ? "recovery_already_cancelled" : "cancelled",
        evidence,
        ["none"],
        "Run is cancelled. Create a new /plan or /goal if work should continue.",
      ),
    };
  }

  if (parsed.command === "approve") {
    if (!parsed.rest) throw new Error("route approve requires a run reference");
    const result = await resolveApprovalTarget({
      reference: parsed.rest,
      recordApproval: true,
      metadata: options.metadata,
    });
    const entry = result.entry;
    if (result.status === "confirmed" && entry) {
      const approvalResolution = await resolveApprovalEntry(defaultStateRoot(), entry.run_id);
      if (approvalResolution.status !== "found") {
        return {
          schema_version: "pilot.route.v0",
          status: "needs_user_decision",
          command: parsed.command,
          enabled: true,
          backend: "openclaw-pilot",
          result_summary: {
            status: "approval_record_missing",
            reference: result.reference,
            run_id: entry.run_id,
            short_run_id: entry.short_run_id,
          },
          user_report: userReport(
            "approval_record_missing",
            result.evidence_pointers,
            ["Approval target was validated, but the approval record could not be resolved for execution."],
            `Retry approve ${entry.short_run_id}, or inspect the approval index before running /goal ${entry.short_run_id}.`,
          ),
        };
      }

      const requestPath = await writeApprovedExecutionRequest(approvalResolution.entry, options.metadata);
      const goalResult = await runGoal({ requestPath });
      return {
        schema_version: "pilot.route.v0",
        status: routeStatusFromGoalStatus(goalResult.status),
        command: parsed.command,
        enabled: true,
        backend: "openclaw-pilot",
        result_summary: {
          status: goalResult.status,
          approval_status: result.status,
          approved_plan_run_id: entry.run_id,
          approved_plan_short_run_id: entry.short_run_id,
          run_id: goalResult.run_id,
          approval_reference: goalResult.request.approval?.reference,
          artifact_dir: goalResult.artifact_dir,
          steps: goalResult.steps.length,
          created_files: goalResult.created_files,
          post_execution_verification: goalResult.post_execution_verification,
          post_execution_convergence: goalResult.post_execution_convergence,
          post_convergence_verification: goalResult.post_convergence_verification,
          lifecycle: goalResult.lifecycle,
          profile_expectations: profileExpectationSummary(goalResult.request.goal.profile),
        },
        user_report: userReport(
          goalVisibleStatus(goalResult),
          [...result.evidence_pointers, ...goalResult.created_files],
          findingRisks(goalResult.findings),
          goalNextAction(goalResult),
        ),
      };
    }

    return {
      schema_version: "pilot.route.v0",
      status:
        result.status === "confirmed"
          ? "approval_target_confirmed"
          : result.status === "invalid"
            ? "blocked"
            : "needs_user_decision",
      command: parsed.command,
      enabled: true,
      backend: "openclaw-pilot",
      result_summary: {
        status: result.status,
        reference: result.reference,
        run_id: entry?.run_id,
        short_run_id: entry?.short_run_id,
        artifact_dir: entry?.artifact_dir,
        source_message_id: entry?.source_message_id,
        source_update_id: entry?.source_update_id,
        channel: entry?.channel,
        goal_status: result.goal?.status,
      },
      user_report: userReport(
        result.status === "confirmed" ? "approval_target_confirmed" : `approval_target_${result.status}`,
        result.evidence_pointers,
        result.remaining_risks,
        result.next_action,
      ),
    };
  }

  if (parsed.command === "/plan") {
    if (!parsed.rest) return usageRoute(parsed.command);
    const result = await runPlan({ request: parsed.rest });
    const shortId = shortRunId(result.run_id);
    const approvalPreview =
      result.status === "completed_plan" ? await readPlanApprovalPreview(result.artifact_dir, shortId, result.run_id) : [];
    return {
      schema_version: "pilot.route.v0",
      status: result.status === "completed_plan" ? "routed" : "needs_user_decision",
      command: parsed.command,
      enabled: true,
      backend: "openclaw-pilot",
      result_summary: {
        status: result.status,
        run_id: result.run_id,
        short_run_id: shortId,
        state_root: result.goal.state_root,
        artifact_dir: result.artifact_dir,
        created_files: result.created_files,
        plan_preview: planPreview(result.plan),
        profile_expectations: profileExpectationSummary(result.goal.profile),
      },
      user_report: userReport(
        result.status === "completed_plan" ? "plan_created" : result.status,
        result.created_files,
        result.status === "needs_user_decision"
          ? result.plan.ambiguity_questions || ["Plan requires user decision before any execution."]
          : ["Execution not performed. This command only created local plan artifacts."],
        result.status === "needs_user_decision"
          ? "Answer the ambiguity questions and rerun /plan."
          : `Review the plan. To continue, reply "approve ${shortId}" or cite full run_id ${result.run_id}.`,
        approvalPreview,
      ),
    };
  }

  if (parsed.command === "/verify") {
    if (!parsed.rest) return usageRoute(parsed.command);
    const result = await runVerify({ packetPath: parsed.rest });
    return {
      schema_version: "pilot.route.v0",
      status: result.verdict === "blocked" ? "blocked" : "routed",
      command: parsed.command,
      enabled: true,
      backend: "openclaw-pilot",
      result_summary: {
        verdict: result.verdict,
        run_id: result.run_id,
        artifact_dir: result.artifact_dir,
        created_files: result.created_files,
        profile_expectations: profileExpectationSummary(result.packet.claim.profile),
      },
      user_report: userReport(
        result.verdict,
        result.created_files,
        findingRisks(result.findings),
        result.verdict === "sufficient_evidence"
          ? "Use the verification artifact as the evidence pointer for the next step."
          : "Revise the evidence packet or run /conv against the listed findings.",
      ),
    };
  }

  if (parsed.command === "/conv") {
    if (!parsed.rest) return usageRoute(parsed.command);
    const result = await runConv({ requestPath: parsed.rest });
    return {
      schema_version: "pilot.route.v0",
      status: result.status === "blocked" ? "blocked" : result.status === "needs_user_decision" ? "needs_user_decision" : "routed",
      command: parsed.command,
      enabled: true,
      backend: "openclaw-pilot",
      result_summary: {
        status: result.status,
        run_id: result.run_id,
        artifact_dir: result.artifact_dir,
        rounds: result.rounds.length,
        created_files: result.created_files,
      },
      user_report: userReport(
        result.status,
        result.created_files,
        result.findings.filter((finding) => finding.status === "open").map((finding) => `${finding.id}: ${finding.description}`),
        result.status === "completed"
          ? "Run /verify with the updated evidence packet when a final verdict is needed."
          : "Provide a tighter anchor, safer capability boundary, or more rounds before retrying /conv.",
      ),
    };
  }

  if (!parsed.rest) return usageRoute(parsed.command);
  let requestPath = parsed.rest;
  let approvalReference: string | undefined;
  if (looksLikeRunReference(parsed.rest)) {
    const resolution = await resolveApprovalEntry(defaultStateRoot(), parsed.rest);
    if (resolution.status === "not_found") {
      return {
        schema_version: "pilot.route.v0",
        status: "needs_user_decision",
        command: parsed.command,
        enabled: true,
        backend: "openclaw-pilot",
        result_summary: { reference: parsed.rest, status: "approval_not_found" },
        user_report: userReport(
          "approval_not_found",
          [],
          [`No approved Pilot run matched /goal reference: ${parsed.rest}.`],
          `Run approve ${parsed.rest} first, then retry /goal ${parsed.rest}.`,
        ),
      };
    }
    if (resolution.status === "ambiguous") {
      return {
        schema_version: "pilot.route.v0",
        status: "needs_user_decision",
        command: parsed.command,
        enabled: true,
        backend: "openclaw-pilot",
        result_summary: { reference: parsed.rest, status: "approval_ambiguous", matches: resolution.matches.map((entry) => entry.run_id) },
        user_report: userReport(
          "approval_ambiguous",
          resolution.matches.map((entry) => entry.run_id),
          [`Approved run reference ${parsed.rest} matched multiple runs.`],
          "Retry /goal with the full run_id from the approval receipt.",
        ),
      };
    }
    if (await isRecoveryRunCancelled(defaultStateRoot(), resolution.entry.run_id)) {
      return {
        schema_version: "pilot.route.v0",
        status: "blocked",
        command: parsed.command,
        enabled: true,
        backend: "openclaw-pilot",
        result_summary: { reference: parsed.rest, status: "approval_cancelled", run_id: resolution.entry.run_id },
        user_report: userReport(
          "approval_cancelled",
          [resolution.entry.artifact_dir],
          [`Approved run ${resolution.entry.short_run_id} has been cancelled.`],
          "Create a new /plan or /goal if the work should continue.",
        ),
      };
    }
    requestPath = await writeApprovedExecutionRequest(resolution.entry, options.metadata);
    approvalReference = resolution.entry.run_id;
  } else if (!looksLikeGoalRequestPath(parsed.rest)) {
    const result = await runPlan({ request: parsed.rest });
    const shortId = shortRunId(result.run_id);
    const approvalPreview =
      result.status === "completed_plan" ? await readPlanApprovalPreview(result.artifact_dir, shortId, result.run_id) : [];
    return {
      schema_version: "pilot.route.v0",
      status: result.status === "completed_plan" ? "routed" : "needs_user_decision",
      command: parsed.command,
      enabled: true,
      backend: "openclaw-pilot",
      result_summary: {
        status: result.status,
        mode: "goal_intake_plan",
        run_id: result.run_id,
        short_run_id: shortId,
        state_root: result.goal.state_root,
        artifact_dir: result.artifact_dir,
        created_files: result.created_files,
        plan_preview: planPreview(result.plan),
        profile_expectations: profileExpectationSummary(result.goal.profile),
      },
      user_report: userReport(
        result.status === "completed_plan" ? "goal_plan_created" : "goal_needs_clarification",
        result.created_files,
        result.status === "needs_user_decision"
          ? result.plan.ambiguity_questions || ["Goal request requires clarification before planning or execution."]
          : ["Execution not performed. This command only created local goal-intake plan artifacts."],
        result.status === "needs_user_decision"
          ? "Answer the ambiguity questions, then rerun /goal with a concrete request."
          : `Review the plan. To continue, reply "approve ${shortId}" or cite full run_id ${result.run_id}.`,
        approvalPreview,
      ),
    };
  }

  const result = await runGoal({ requestPath });
  return {
    schema_version: "pilot.route.v0",
    status: routeStatusFromGoalStatus(result.status),
    command: parsed.command,
    enabled: true,
    backend: "openclaw-pilot",
    result_summary: {
      status: result.status,
      run_id: result.run_id,
      approval_reference: approvalReference || result.request.approval?.reference,
      artifact_dir: result.artifact_dir,
      steps: result.steps.length,
      created_files: result.created_files,
      post_execution_verification: result.post_execution_verification,
      post_execution_convergence: result.post_execution_convergence,
      post_convergence_verification: result.post_convergence_verification,
      lifecycle: result.lifecycle,
      profile_expectations: profileExpectationSummary(result.request.goal.profile),
    },
    user_report: userReport(
      goalVisibleStatus(result),
      result.created_files,
      findingRisks(result.findings),
      goalNextAction(result),
    ),
  };
}
