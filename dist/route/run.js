import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveApprovalTarget } from "../approval/run.js";
import { runConv } from "../conv/run.js";
import { runGoal } from "../goal/run.js";
import { runPlan } from "../plan/run.js";
import { profileExpectationSummary } from "../profiles/index.js";
import { resolveApprovalEntry } from "../state/approval-index.js";
import { shortRunId } from "../state/run-index.js";
import { defaultStateRoot } from "../config.js";
import { runVerify } from "../verify/run.js";
const routeCommands = new Set(["/plan", "/verify", "/conv", "/goal", "approve"]);
function userReport(status, evidencePointers, remainingRisks, nextAction) {
    return {
        status,
        evidence_pointers: evidencePointers,
        remaining_risks: remainingRisks.length > 0 ? remainingRisks : ["none"],
        next_action: nextAction,
    };
}
function findingRisks(findings) {
    return findings
        .filter((finding) => finding.severity !== "info")
        .map((finding) => `${finding.code}: ${finding.message}`);
}
function routeStatusFromGoalStatus(status) {
    if (status === "blocked")
        return "blocked";
    if (status === "awaiting_approval")
        return "awaiting_approval";
    if (status === "needs_user_decision" || status === "needs_evidence" || status === "needs_revision") {
        return "needs_user_decision";
    }
    return "routed";
}
function goalVisibleStatus(result) {
    return result.lifecycle?.user_status || result.status;
}
function goalNextAction(result) {
    return result.lifecycle?.next_action || "Inspect goal-run.json and final.md before retrying.";
}
function unavailable(command) {
    return {
        schema_version: "pilot.route.v0",
        status: "unavailable",
        command,
        enabled: false,
        backend: "openclaw-pilot",
        fallback_message: "Pilot exact routing is not enabled. No legacy backend was invoked.",
        user_report: userReport("unavailable", [], ["Pilot exact routing is disabled."], "Enable Pilot exact routing before retrying this command."),
    };
}
function parseRouteInput(input) {
    const trimmed = input.trim();
    const [rawCommand, ...restParts] = trimmed.split(/\s+/);
    if (!routeCommands.has(rawCommand)) {
        throw new Error(`unsupported exact command: ${rawCommand || "(empty)"}`);
    }
    return {
        command: rawCommand,
        rest: restParts.join(" ").trim(),
    };
}
function metadataString(metadata, key) {
    const value = metadata?.[key];
    if (value === undefined || value === null)
        return undefined;
    const text = String(value).trim();
    return text || undefined;
}
function looksLikeRunReference(value) {
    return /^\d{6}$/.test(value) || /^\d{8}T\d{6}Z-[a-z0-9가-힣-]+$/.test(value);
}
function looksLikeGoalRequestPath(value) {
    return /\.json$/i.test(value) || value.includes("/") || value.includes("\\");
}
async function readPlanGoal(entry) {
    const parsed = JSON.parse(await readFile(join(entry.artifact_dir, "goal.json"), "utf8"));
    if (parsed.schema_version !== "pilot.goal.v0")
        throw new Error("approved plan goal artifact is invalid");
    if (parsed.run_id !== entry.run_id)
        throw new Error("approved plan goal artifact does not match approval run");
    if (parsed.status !== "completed_plan")
        throw new Error(`approved plan is not executable: ${parsed.status}`);
    return parsed;
}
function assertApprovalScope(entry, metadata) {
    const risks = [];
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
function approvedPlanContract(entry, goal) {
    if (entry.approved_capabilities.includes("run_codex_session")) {
        return {
            goal: `Execute approved Codex/session work for Pilot plan run ${entry.short_run_id}.`,
            scope: entry.approved_scope,
            out_of_scope: [
                "Actions outside the approved plan",
                "External public posts or third-party messages unless the approved plan explicitly names them",
                "Payments or irreversible account changes unless the approved plan explicitly names them",
            ],
            success_criteria: [
                "A runner prompt artifact exists.",
                "The approved Codex/session runner completes with exit code 0.",
                "Runner stdout/stderr and result metadata are captured as artifacts.",
                "A typed receipt records the run_codex_session capability.",
                `The execution references approved plan run ${entry.run_id}.`,
            ],
            risks_assumptions: [
                "The runner operates only within the approved plan boundary.",
                "The runner must stop and report if it needs out-of-plan work.",
                `Original request: ${goal.request}`,
            ],
            action_boundaries: {
                allowed_actions: ["run_codex_session"],
                approval_required_actions: ["execute the approved Codex/session runner task"],
                disallowed_actions: ["out_of_plan_action", "vague_broad_authority", "unreported_external_action"],
            },
            verification_gates: [
                "runner-result.json exists",
                "runner-stdout.txt exists",
                "runner-stderr.txt exists",
                "receipts.jsonl contains pilot.receipt.v0 for run_codex_session",
                `approval reference equals ${entry.run_id}`,
            ],
            next_recommended_step: "Inspect runner-result.json, stdout/stderr, and the final report.",
        };
    }
    if (entry.approved_capabilities.includes("create_pilot_receipts_dashboard")) {
        return {
            goal: `Create a local Pilot receipts dashboard prototype for approved plan run ${entry.short_run_id}.`,
            scope: entry.approved_scope,
            out_of_scope: [
                "External messages",
                "Network calls",
                "Server startup",
                "Telegram routing side effects",
                "Agent spawning",
                "Filesystem mutation outside the new goal run artifact directory",
            ],
            success_criteria: [
                "A new local goal-run artifact directory exists.",
                "A self-contained HTML dashboard prototype exists in that directory.",
                "The dashboard includes local Pilot receipt data summarized from receipts.jsonl artifacts.",
                "A typed receipt records the create_pilot_receipts_dashboard capability.",
                `The execution references approved plan run ${entry.run_id}.`,
            ],
            risks_assumptions: [
                "This is a local static prototype, not a running web app or deployed service.",
                "Receipt data is read from the local Pilot state directory and embedded into the generated artifact.",
                `Original request: ${goal.request}`,
            ],
            action_boundaries: {
                allowed_actions: ["create_pilot_receipts_dashboard"],
                approval_required_actions: ["create a local Pilot receipts dashboard prototype for the approved plan run"],
                disallowed_actions: [
                    "external_message",
                    "network_call",
                    "shell_escape",
                    "telegram_routing",
                    "agent_spawn",
                    "deploy",
                    "release",
                    "server_restart",
                    "destructive_filesystem",
                ],
            },
            verification_gates: [
                "goal-run.json exists",
                "pilot-receipts-dashboard.html exists",
                "receipts.jsonl contains pilot.receipt.v0 for create_pilot_receipts_dashboard",
                `approval reference equals ${entry.run_id}`,
            ],
            next_recommended_step: "Open the generated dashboard HTML locally and inspect the receipt summary.",
        };
    }
    return {
        goal: `Execute approved local scoped flow for Pilot plan run ${entry.short_run_id}.`,
        scope: entry.approved_scope,
        out_of_scope: [
            "External messages",
            "Shell execution",
            "Telegram routing side effects",
            "Agent spawning",
            "Filesystem mutation outside the new goal run artifact directory",
        ],
        success_criteria: [
            "A new local goal-run artifact directory exists.",
            "A scoped local goal artifact exists.",
            "A typed receipt records the create_artifact capability.",
            `The execution references approved plan run ${entry.run_id}.`,
        ],
        risks_assumptions: [
            "This flow validates approval continuity and local receipt creation only.",
            "It does not execute the user's original task semantics.",
            `Original request: ${goal.request}`,
        ],
        action_boundaries: {
            allowed_actions: ["create_artifact"],
            approval_required_actions: ["create local goal artifact for the approved Pilot plan run"],
            disallowed_actions: [
                "external_message",
                "shell_escape",
                "telegram_routing",
                "agent_spawn",
                "deploy",
                "release",
                "server_restart",
                "destructive_filesystem",
            ],
        },
        verification_gates: [
            "goal-run.json exists",
            "step-1-goal-artifact.md exists",
            "receipts.jsonl contains pilot.receipt.v0",
            `approval reference equals ${entry.run_id}`,
        ],
        next_recommended_step: "Inspect the goal-run artifact and receipt before widening execution behavior.",
    };
}
async function writeApprovedGoalRequest(entry, metadata) {
    const scopeRisks = assertApprovalScope(entry, metadata);
    if (scopeRisks.length > 0)
        throw new Error(scopeRisks.join(" "));
    const goal = await readPlanGoal(entry);
    const createsDashboard = entry.approved_capabilities.includes("create_pilot_receipts_dashboard");
    const runsSession = entry.approved_capabilities.includes("run_codex_session");
    const request = {
        schema_version: "pilot.goal_request.v0",
        goal: {
            id: `approved-${entry.short_run_id}`,
            statement: runsSession
                ? `Execute approved Codex/session work for Pilot plan run ${entry.short_run_id}: ${goal.request}`
                : createsDashboard
                    ? `Create a local Pilot receipts dashboard prototype for approved Pilot plan run ${entry.short_run_id}: ${goal.request}`
                    : `Create a bounded local goal artifact for approved Pilot plan run ${entry.short_run_id}: ${goal.request}`,
            profile: goal.profile,
        },
        plan: approvedPlanContract(entry, goal),
        approval: {
            reference: entry.run_id,
            approved: true,
            approved_scope: entry.approved_scope,
            approved_capabilities: entry.approved_capabilities,
        },
        preflight: {
            risk_class: runsSession ? "high" : "low",
            typed_capabilities: entry.approved_capabilities,
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
    };
    const requestPath = join(entry.artifact_dir, "approved-goal-request.json");
    await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
    return requestPath;
}
export async function runRoute(options) {
    const parsed = parseRouteInput(options.input);
    if (!options.enabled)
        return unavailable(parsed.command);
    if (parsed.command === "approve") {
        if (!parsed.rest)
            throw new Error("route approve requires a run reference");
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
                    user_report: userReport("approval_record_missing", result.evidence_pointers, ["Approval target was validated, but the approval record could not be resolved for execution."], `Retry approve ${entry.short_run_id}, or inspect the approval index before running /goal ${entry.short_run_id}.`),
                };
            }
            const requestPath = await writeApprovedGoalRequest(approvalResolution.entry, options.metadata);
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
                user_report: userReport(goalVisibleStatus(goalResult), [...result.evidence_pointers, ...goalResult.created_files], findingRisks(goalResult.findings), goalNextAction(goalResult)),
            };
        }
        return {
            schema_version: "pilot.route.v0",
            status: result.status === "confirmed"
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
            user_report: userReport(result.status === "confirmed" ? "approval_target_confirmed" : `approval_target_${result.status}`, result.evidence_pointers, result.remaining_risks, result.next_action),
        };
    }
    if (parsed.command === "/plan") {
        if (!parsed.rest)
            throw new Error("route /plan requires a request");
        const result = await runPlan({ request: parsed.rest });
        const shortId = shortRunId(result.run_id);
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
                profile_expectations: profileExpectationSummary(result.goal.profile),
            },
            user_report: userReport(result.status === "completed_plan" ? "plan_created" : result.status, result.created_files, result.status === "needs_user_decision"
                ? result.plan.ambiguity_questions || ["Plan requires user decision before any execution."]
                : ["Execution not performed. This command only created local plan artifacts."], result.status === "needs_user_decision"
                ? "Answer the ambiguity questions and rerun /plan."
                : `Review the plan. To continue, reply "approve ${shortId}" or cite full run_id ${result.run_id}.`),
        };
    }
    if (parsed.command === "/verify") {
        if (!parsed.rest)
            throw new Error("route /verify requires an evidence packet JSON path");
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
            user_report: userReport(result.verdict, result.created_files, findingRisks(result.findings), result.verdict === "sufficient_evidence"
                ? "Use the verification artifact as the evidence pointer for the next step."
                : "Revise the evidence packet or run /conv against the listed findings."),
        };
    }
    if (parsed.command === "/conv") {
        if (!parsed.rest)
            throw new Error("route /conv requires a conv request JSON path");
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
            user_report: userReport(result.status, result.created_files, result.findings.filter((finding) => finding.status === "open").map((finding) => `${finding.id}: ${finding.description}`), result.status === "completed"
                ? "Run /verify with the updated evidence packet when a final verdict is needed."
                : "Provide a tighter anchor, safer capability boundary, or more rounds before retrying /conv."),
        };
    }
    if (!parsed.rest)
        throw new Error("route /goal requires a goal request, goal request JSON path, or approved run reference");
    let requestPath = parsed.rest;
    let approvalReference;
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
                user_report: userReport("approval_not_found", [], [`No approved Pilot run matched /goal reference: ${parsed.rest}.`], `Run approve ${parsed.rest} first, then retry /goal ${parsed.rest}.`),
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
                user_report: userReport("approval_ambiguous", resolution.matches.map((entry) => entry.run_id), [`Approved run reference ${parsed.rest} matched multiple runs.`], "Retry /goal with the full run_id from the approval receipt."),
            };
        }
        requestPath = await writeApprovedGoalRequest(resolution.entry, options.metadata);
        approvalReference = resolution.entry.run_id;
    }
    else if (!looksLikeGoalRequestPath(parsed.rest)) {
        const result = await runPlan({ request: parsed.rest });
        const shortId = shortRunId(result.run_id);
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
                profile_expectations: profileExpectationSummary(result.goal.profile),
            },
            user_report: userReport(result.status === "completed_plan" ? "goal_plan_created" : "goal_needs_clarification", result.created_files, result.status === "needs_user_decision"
                ? result.plan.ambiguity_questions || ["Goal request requires clarification before planning or execution."]
                : ["Execution not performed. This command only created local goal-intake plan artifacts."], result.status === "needs_user_decision"
                ? "Answer the ambiguity questions, then rerun /goal with a concrete request."
                : `Review the plan. To continue, reply "approve ${shortId}" or cite full run_id ${result.run_id}.`),
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
        user_report: userReport(goalVisibleStatus(result), result.created_files, findingRisks(result.findings), goalNextAction(result)),
    };
}
