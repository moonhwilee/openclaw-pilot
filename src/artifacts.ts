import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  EventRecord,
  GoalArtifact,
  CommonPlanContract,
  ConvResult,
  GoalRunResult,
  VerificationResult,
} from "./types.ts";

export function slugifyRequest(request: string): string {
  const slug = request
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "request";
}

export function createRunId(request: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${slugifyRequest(request)}`;
}

export async function prepareRunDirectory(stateRoot: string, runId: string): Promise<string> {
  const artifactDir = join(stateRoot, "runs", runId);
  await mkdir(artifactDir, { recursive: true });
  return artifactDir;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function eventLine(event: EventRecord): string {
  return `${JSON.stringify(event)}\n`;
}

export function renderPlanMarkdown(plan: CommonPlanContract): string {
  const lines = [
    "# Pilot Plan",
    "",
    "## Goal",
    "",
    plan.goal,
    "",
    "## Scope",
    "",
    ...plan.scope.map((item) => `- ${item}`),
    "",
    "## Out Of Scope",
    "",
    ...plan.out_of_scope.map((item) => `- ${item}`),
    "",
    "## Success Criteria",
    "",
    ...plan.success_criteria.map((item) => `- ${item}`),
    "",
    "## Risks / Assumptions",
    "",
    ...plan.risks_assumptions.map((item) => `- ${item}`),
    "",
    "## Action Boundaries",
    "",
    "Allowed:",
    ...plan.action_boundaries.allowed_actions.map((item) => `- ${item}`),
    "",
    "Approval required:",
    ...plan.action_boundaries.approval_required_actions.map((item) => `- ${item}`),
    "",
    "Disallowed:",
    ...plan.action_boundaries.disallowed_actions.map((item) => `- ${item}`),
    "",
    "## Verification Gates",
    "",
    ...plan.verification_gates.map((item) => `- ${item}`),
  ];

  if (plan.ambiguity_questions?.length) {
    lines.push("", "## Ambiguity / Questions", "", ...plan.ambiguity_questions.map((item) => `- ${item}`));
  }

  if (plan.next_recommended_step) {
    lines.push("", "## Next Recommended Step", "", plan.next_recommended_step);
  }

  if (plan.detailed_task_breakdown?.length) {
    lines.push("", "## Detailed Task Breakdown", "", ...plan.detailed_task_breakdown.map((item) => `- ${item}`));
  }

  return `${lines.join("\n")}\n`;
}

export function renderFinalMarkdown(goal: GoalArtifact): string {
  return [
    "# Pilot Phase 1 Result",
    "",
    `Status: ${goal.status}`,
    `Run ID: ${goal.run_id}`,
    `Profile: ${goal.profile}`,
    "",
    "Artifacts:",
    "",
    "- `goal.json`",
    "- `plan.md`",
    "- `events.jsonl`",
    "- `final.md`",
    "",
    "Execution: not performed. Phase 1 only creates a local plan artifact.",
    "",
  ].join("\n");
}

export function renderVerificationMarkdown(result: VerificationResult): string {
  return [
    "# Pilot Verification Result",
    "",
    `Verdict: ${result.verdict}`,
    `Run ID: ${result.run_id}`,
    `Claim: ${result.packet.claim.statement}`,
    "",
    "Findings:",
    "",
    ...result.findings.map((finding) => `- ${finding.severity}: ${finding.code} - ${finding.message}`),
    "",
    "Execution: not performed. Phase 2 only evaluates the supplied evidence packet.",
    "Semantic judgment: not performed by deterministic code.",
    "",
  ].join("\n");
}

export function renderConvMarkdown(result: ConvResult): string {
  return [
    "# Pilot Convergence Result",
    "",
    `Status: ${result.status}`,
    `Run ID: ${result.run_id}`,
    `Anchor: ${result.anchor.id}`,
    "",
    "Findings:",
    "",
    ...result.findings.map((finding) => `- ${finding.status}: ${finding.id} - ${finding.description}`),
    "",
    "Rounds:",
    "",
    ...result.rounds.map((round) => `- round ${round.round}: ${round.verdict} - ${round.action_summary}`),
    "",
    "Execution boundary: local artifact notes only. No external action, shell task, agent spawn, goal execution, or Telegram routing.",
    "",
  ].join("\n");
}

export function renderGoalRunMarkdown(result: GoalRunResult): string {
  const executionBoundary = result.request.preflight.typed_capabilities.includes("run_codex_session")
    ? "Execution boundary: approved Codex/session runner only. Stop required for actions outside the approved plan."
    : "Execution boundary: scoped local goal artifacts only. No Telegram routing, external action, agent spawn, or dangerous action.";
  const lifecycle = result.lifecycle;

  return [
    "# Pilot Goal Result",
    "",
    `Status: ${result.status}`,
    ...(lifecycle
      ? [
          `User Status: ${lifecycle.user_status}`,
          `Current Phase: ${lifecycle.current_phase}`,
          `Next Action: ${lifecycle.next_action}`,
        ]
      : []),
    `Run ID: ${result.run_id}`,
    `Goal: ${result.request.goal.statement}`,
    "",
    ...(lifecycle
      ? [
          "Lifecycle:",
          "",
          ...lifecycle.steps.map((step) => `- ${step.phase}: ${step.status} - ${step.detail}`),
          "",
        ]
      : []),
    "Steps:",
    "",
    ...(result.steps.length
      ? result.steps.map((step) => `- step ${step.step}: ${step.capability} - ${step.action_summary}`)
      : ["- none"]),
    "",
    "Findings:",
    "",
    ...(result.findings.length
      ? result.findings.map((finding) => `- ${finding.severity}: ${finding.code} - ${finding.message}`)
      : ["- none"]),
    "",
    "Post-Execution Verification:",
    "",
    result.post_execution_verification
      ? `- ${result.post_execution_verification.verdict}: ${result.post_execution_verification.run_id}`
      : "- not run",
    "",
    "Post-Execution Convergence:",
    "",
    result.post_execution_convergence
      ? `- ${result.post_execution_convergence.status}: ${result.post_execution_convergence.run_id} (${result.post_execution_convergence.rounds} rounds)`
      : "- not run",
    "",
    "Post-Convergence Verification:",
    "",
    result.post_convergence_verification
      ? `- ${result.post_convergence_verification.verdict}: ${result.post_convergence_verification.run_id}`
      : "- not run",
    "",
    executionBoundary,
    "",
  ].join("\n");
}
