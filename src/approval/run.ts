import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { defaultStateRoot } from "../config.ts";
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

const requiredArtifactNames = ["goal.json", "plan.md", "events.jsonl", "final.md"] as const;

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

function isPilotReceiptsDashboardRequest(request: string): boolean {
  const normalized = request.toLowerCase();
  return normalized.includes("dashboard") && normalized.includes("receipt");
}

function hasLocalFileReference(request: string): boolean {
  return /(?:^|\s)(?:\/Users\/\S+|\/tmp\/\S+|\.{1,2}\/\S+|\S+\/\S+\.[A-Za-z0-9]{1,12})(?:\s|$|[.,;:!?")\]])/.test(
    request,
  );
}

function asksToMutateLocalFile(request: string): boolean {
  const normalized = request.toLowerCase();
  const mutationTokens = [
    "create",
    "write",
    "save",
    "generate",
    "make",
    "update",
    "modify",
    "edit",
    "append",
    "replace",
    "touch",
    "생성",
    "작성",
    "저장",
    "수정",
    "추가",
    "교체",
  ];
  return hasLocalFileReference(request) && mutationTokens.some((token) => normalized.includes(token));
}

function isRunnerBackedGoalRequest(request: string): boolean {
  const normalized = request.toLowerCase();
  return asksToMutateLocalFile(request) || [
    "implement",
    "code",
    "fix",
    "test",
    "refactor",
    "runner",
    "codex",
    "session",
    "구현",
    "수정",
    "테스트",
    "리팩터",
  ].some((token) => normalized.includes(token));
}

function approvedExecutionBoundary(entry: PilotRunIndexEntry, goal: GoalArtifact): {
  approved_scope: string[];
  approved_capabilities: string[];
  next_action: string;
} {
  if (isRunnerBackedGoalRequest(goal.request)) {
    return {
      approved_scope: [
        `Approved Codex/session runner execution for Pilot plan run ${entry.short_run_id}.`,
        "Execute the concrete work described in the approved plan.",
        "Edit files, run checks, and collect results only within the approved plan boundary.",
        "Stop and report if the runner discovers required work outside the approved plan.",
      ],
      approved_capabilities: ["run_codex_session"],
      next_action: `Run /goal ${entry.short_run_id} to execute the approved Codex/session runner slice.`,
    };
  }

  if (isPilotReceiptsDashboardRequest(goal.request)) {
    return {
      approved_scope: [
        `Approved local dashboard prototype execution for Pilot plan run ${entry.short_run_id}.`,
        "Create a self-contained local Pilot receipts dashboard inside the new goal run artifact directory.",
        "Read local Pilot receipt artifacts as source data; do not mutate files outside the new goal run artifact directory.",
      ],
      approved_capabilities: ["create_pilot_receipts_dashboard"],
      next_action: `Run /goal ${entry.short_run_id} to create the approved local Pilot receipts dashboard prototype.`,
    };
  }

  return {
    approved_scope: [
      `Approved local scoped execution for Pilot plan run ${entry.short_run_id}.`,
      "Create local Pilot goal artifacts only.",
    ],
    approved_capabilities: ["create_artifact"],
    next_action: `Run /goal ${entry.short_run_id} to execute the approved local scoped artifact flow.`,
  };
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
  const boundary = approvedExecutionBoundary(entry, goal);
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
    approved_scope: boundary.approved_scope,
    approved_capabilities: boundary.approved_capabilities,
    next_action: boundary.next_action,
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
    resume_hint: boundary.next_action,
    metadata: {
      reference,
      approved_capabilities: boundary.approved_capabilities.join(","),
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
