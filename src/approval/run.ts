import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { defaultStateRoot } from "../config.ts";
import {
  executionPlanArtifactName,
  executionPlanCapabilities,
  executionPlanRiskClass,
  executionPlanScope,
  hashExecutionPlan,
  readExecutionPlan,
} from "../execution-plan.ts";
import { validateExecutionPlan } from "../schema/index.ts";
import { appendApprovalEntry } from "../state/approval-index.ts";
import { appendLineageRecord } from "../state/lineage.ts";
import { isRecoveryRunCancelled } from "../state/recovery.ts";
import { resolveRunIndexEntry } from "../state/run-index.ts";
import type { GoalArtifact, PilotApprovalEntry, PilotRunIndexEntry } from "../types.ts";

export type ApprovalTargetStatus = "confirmed" | "not_found" | "ambiguous" | "invalid";

export type ApprovalTargetResult = {
  status: ApprovalTargetStatus;
  reference: string;
  entry?: PilotRunIndexEntry;
  goal?: GoalArtifact;
  evidence_pointers: string[];
  remaining_risks: string[];
  next_action: string;
};

export type ResolveApprovalTargetOptions = {
  reference: string;
  stateRoot?: string;
  recordApproval?: boolean;
  metadata?: Record<string, unknown>;
};

const requiredArtifactNames = ["goal.json", "plan.md", executionPlanArtifactName, "events.jsonl", "final.md"] as const;

async function fileExists(path: string): Promise<boolean> {
  try {
    const result = await stat(path);
    return result.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readGoalArtifact(path: string): Promise<GoalArtifact | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<GoalArtifact>;
    if (parsed.schema_version !== "pilot.goal.v0") return undefined;
    if (typeof parsed.run_id !== "string") return undefined;
    if (typeof parsed.status !== "string") return undefined;
    if (typeof parsed.artifact_dir !== "string") return undefined;
    return parsed as GoalArtifact;
  } catch {
    return undefined;
  }
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

async function recordApproval(
  stateRoot: string,
  reference: string,
  entry: PilotRunIndexEntry,
  goal: GoalArtifact,
  metadata: Record<string, unknown> | undefined,
): Promise<string[]> {
  const executionPlanPath = join(entry.artifact_dir, executionPlanArtifactName);
  const executionPlan = await readExecutionPlan(executionPlanPath);
  const validationErrors = validateExecutionPlan(executionPlan);
  if (executionPlan.plan_run_id !== entry.run_id) {
    validationErrors.push(`execution plan run_id does not match approval target: ${entry.run_id}`);
  }
  const executionPlanHash = hashExecutionPlan(executionPlan);
  if (executionPlanHash !== executionPlan.approval_subject_hash) {
    validationErrors.push("execution plan hash does not match approval subject");
  }
  if (validationErrors.length > 0) {
    throw new Error(`execution plan is not approvable: ${validationErrors.join("; ")}`);
  }
  const approvedScope = executionPlanScope(executionPlan);
  const approvedCapabilities = executionPlanCapabilities(executionPlan);
  const riskClass = executionPlanRiskClass(executionPlan);
  const nextAction = `Run /goal ${entry.short_run_id} from the approved execution_plan (${executionPlanHash.slice(0, 12)}).`;
  const createdAt = new Date().toISOString();
  const approval: PilotApprovalEntry = {
    schema_version: "pilot.approval.v0",
    created_at: createdAt,
    channel: metadataString(metadata, "channel") || entry.channel,
    chat_id: metadataString(metadata, "chat_id") || entry.chat_id,
    sender_id: metadataString(metadata, "sender_id") || entry.sender_id,
    source_message_id: metadataString(metadata, "message_id"),
    source_update_id: metadataString(metadata, "update_id"),
    reference,
    run_id: entry.run_id,
    short_run_id: entry.short_run_id,
    artifact_dir: entry.artifact_dir,
    status: "approved",
    approved_scope: approvedScope,
    approved_capabilities: approvedCapabilities,
    execution_plan_ref: executionPlanPath,
    execution_plan_hash: executionPlanHash,
    next_action: nextAction,
  };
  const approvalPath = await appendApprovalEntry(stateRoot, approval);
  const lineage = await appendLineageRecord(stateRoot, {
    schema_version: "pilot.lineage.v0",
    created_at: createdAt,
    record_type: "approval",
    command: "approve",
    run_id: entry.run_id,
    short_run_id: entry.short_run_id,
    status: "approved",
    state_root: stateRoot,
    artifact_dir: entry.artifact_dir,
    evidence_pointers: [...requiredArtifactNames.map((name) => join(entry.artifact_dir, name)), approvalPath],
    receipt_pointers: [approvalPath],
    resume_hint: nextAction,
    metadata: {
      reference,
      execution_plan_hash: executionPlanHash,
      execution_capabilities: approvedCapabilities.join(","),
      execution_risk_class: riskClass,
    },
  });
  return [approvalPath, lineage.run_path];
}

export async function resolveApprovalTarget(
  options: ResolveApprovalTargetOptions,
): Promise<ApprovalTargetResult> {
  const reference = options.reference.trim();
  const stateRoot = options.stateRoot || defaultStateRoot();
  const resolution = await resolveRunIndexEntry(stateRoot, reference);

  if (resolution.status === "not_found") {
    return {
      status: "not_found",
      reference,
      evidence_pointers: [],
      remaining_risks: [`No Pilot run matched approval reference: ${reference || "(empty)"}.`],
      next_action: "Send approve <Run> from a recent /plan receipt, or cite the full run_id.",
    };
  }

  if (resolution.status === "ambiguous") {
    return {
      status: "ambiguous",
      reference,
      evidence_pointers: resolution.matches.map((entry) => entry.run_id),
      remaining_risks: [`Approval reference ${reference} matched multiple runs.`],
      next_action: "Retry with the full run_id from the /plan receipt.",
    };
  }

  const entry = resolution.entry;
  const cancelled = await isRecoveryRunCancelled(stateRoot, entry.run_id);
  const artifactPaths = requiredArtifactNames.map((name) => join(entry.artifact_dir, name));
  const missingArtifacts = (
    await Promise.all(
      artifactPaths.map(async (path, index) => ({
        name: requiredArtifactNames[index],
        exists: await fileExists(path),
      })),
    )
  )
    .filter((artifact) => !artifact.exists)
    .map((artifact) => artifact.name);

  const goal = await readGoalArtifact(join(entry.artifact_dir, "goal.json"));
  const validationRisks: string[] = [];
  if (cancelled) {
    validationRisks.push(`Pilot run is cancelled: ${entry.short_run_id}.`);
  }
  if (missingArtifacts.length > 0) {
    validationRisks.push(`Missing plan artifacts: ${missingArtifacts.join(", ")}.`);
  }
  if (!goal) {
    validationRisks.push("goal.json is missing or not a valid Pilot goal artifact.");
  } else {
    if (goal.run_id !== entry.run_id) {
      validationRisks.push(`goal.json run_id does not match index run_id: ${entry.run_id}.`);
    }
    if (goal.status !== "completed_plan") {
      validationRisks.push(`Plan run is not ready for approval resolution: ${goal.status}.`);
    }
  }

  if (validationRisks.length > 0) {
    return {
      status: "invalid",
      reference,
      entry,
      goal,
      evidence_pointers: artifactPaths,
      remaining_risks: validationRisks,
      next_action: "Inspect the listed artifacts before attempting approval again.",
    };
  }

  const evidencePointers = [...artifactPaths];
  if (options.recordApproval && goal) {
    evidencePointers.push(...(await recordApproval(stateRoot, reference, entry, goal, options.metadata)));
  }

  return {
    status: "confirmed",
    reference,
    entry,
    goal,
    evidence_pointers: evidencePointers,
    remaining_risks: ["Execution not performed. Approval target was resolved, validated, and recorded only."],
    next_action: `Approval target confirmed for run ${entry.short_run_id}. To execute the approved local scoped flow, run /goal ${entry.short_run_id}.`,
  };
}
