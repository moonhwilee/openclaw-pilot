import { runConv } from "../conv/run.ts";
import { runGoal } from "../goal/run.ts";
import { runPlan } from "../plan/run.ts";
import { profileExpectationSummary } from "../profiles/index.ts";
import { runVerify } from "../verify/run.ts";
import type { GoalRunStatus, RouteResult, RouteStatus, RouteUserReport, VerificationFinding } from "../types.ts";

export type RunRouteOptions = {
  input: string;
  enabled: boolean;
};

const routeCommands = new Set(["/plan", "/verify", "/conv", "/goal"]);

function userReport(
  status: string,
  evidencePointers: string[],
  remainingRisks: string[],
  nextAction: string,
): RouteUserReport {
  return {
    status,
    evidence_pointers: evidencePointers,
    remaining_risks: remainingRisks.length > 0 ? remainingRisks : ["none"],
    next_action: nextAction,
  };
}

function findingRisks(findings: VerificationFinding[]): string[] {
  return findings
    .filter((finding) => finding.code !== "structural_evidence_sufficient")
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

export async function runRoute(options: RunRouteOptions): Promise<RouteResult> {
  const parsed = parseRouteInput(options.input);

  if (!options.enabled) return unavailable(parsed.command);

  if (parsed.command === "/plan") {
    if (!parsed.rest) throw new Error("route /plan requires a request");
    const result = await runPlan({ request: parsed.rest });
    return {
      schema_version: "pilot.route.v0",
      status: result.status === "completed_plan" ? "routed" : "needs_user_decision",
      command: parsed.command,
      enabled: true,
      backend: "openclaw-pilot",
      result_summary: {
        status: result.status,
        run_id: result.run_id,
        artifact_dir: result.artifact_dir,
        created_files: result.created_files,
        profile_expectations: profileExpectationSummary(result.goal.profile),
      },
      user_report: userReport(
        result.status,
        result.created_files,
        result.status === "needs_user_decision"
          ? result.plan.ambiguity_questions || ["Plan requires user decision before any execution."]
          : ["Plan mode did not execute; execution still requires a scoped goal approval."],
        result.status === "needs_user_decision"
          ? "Answer the ambiguity questions and rerun /plan."
          : "Review the plan artifact before creating or approving a scoped /goal.",
      ),
    };
  }

  if (parsed.command === "/verify") {
    if (!parsed.rest) throw new Error("route /verify requires an evidence packet JSON path");
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
    if (!parsed.rest) throw new Error("route /conv requires a conv request JSON path");
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

  if (!parsed.rest) throw new Error("route /goal requires a goal request JSON path");
  const result = await runGoal({ requestPath: parsed.rest });
  return {
    schema_version: "pilot.route.v0",
    status: routeStatusFromGoalStatus(result.status),
    command: parsed.command,
    enabled: true,
    backend: "openclaw-pilot",
    result_summary: {
      status: result.status,
      run_id: result.run_id,
      artifact_dir: result.artifact_dir,
      steps: result.steps.length,
      created_files: result.created_files,
      profile_expectations: profileExpectationSummary(result.request.goal.profile),
    },
    user_report: userReport(
      result.status,
      result.created_files,
      findingRisks(result.findings),
      result.status === "awaiting_approval"
        ? "Provide explicit scoped approval with concrete capabilities before execution."
        : result.status === "completed"
          ? "Use receipts and the final artifact as the proof for completion."
          : "Fix the listed approval, scope, evidence, or risk issue before retrying /goal.",
    ),
  };
}
