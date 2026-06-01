import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRunId, eventLine, prepareRunDirectory, renderGoalRunMarkdown, writeJson } from "../artifacts.js";
import { defaultStateRoot } from "../config.js";
import { runConv } from "../conv/run.js";
import { executionPlanCapabilities } from "../execution-plan.js";
import { validateGoalRequest } from "../schema/index.js";
import { appendLineageRecord } from "../state/lineage.js";
import { shortRunId } from "../state/run-index.js";
import { runVerify } from "../verify/run.js";
import { getGoalCapabilityRunner } from "./capabilities.js";
import { buildGoalLifecycleSummary } from "./lifecycle.js";
import { buildPostConvergenceEvidencePacket, buildPostExecutionConvRequest, buildPostExecutionEvidencePacket, fixableVerificationVerdict, } from "./post-execution.js";
function needsPlanSemantics(request) {
    return request.plan.ambiguity_questions !== undefined && request.plan.ambiguity_questions.length > 0;
}
function approvalCoversExecutionPlan(request) {
    if (!request.approval?.approved)
        return false;
    if (!request.execution_plan)
        return false;
    return request.approval.execution_plan_hash === request.execution_plan.approval_subject_hash;
}
function collectPreExecutionFindings(request, validationErrors) {
    const findings = validationErrors.map((message) => ({
        code: "goal_request_invalid",
        message,
        severity: "error",
    }));
    if (validationErrors.length > 0)
        return findings;
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
    }
    else if (!approvalCoversExecutionPlan(request)) {
        findings.push({
            code: "approval_scope_mismatch",
            message: "Approval does not cover the attached execution_plan hash.",
            severity: "error",
        });
    }
    return findings;
}
function isHardBlock(message) {
    return message.includes("invalid goal request schema version")
        || message.includes("missing goal id")
        || message.includes("missing goal statement")
        || message.includes("invalid goal profile")
        || message.includes("missing plan")
        || message.includes("missing preflight");
}
async function pathExists(path) {
    try {
        await stat(path);
        return true;
    }
    catch {
        return false;
    }
}
function chooseStatus(findings) {
    if (findings.some((finding) => finding.code === "goal_request_invalid" && isHardBlock(finding.message)))
        return "blocked";
    if (findings.some((finding) => finding.code === "goal_request_invalid"))
        return "needs_user_decision";
    if (findings.some((finding) => finding.code === "goal_requires_plan_semantics"))
        return "needs_user_decision";
    if (findings.some((finding) => finding.code === "approval_required"))
        return "awaiting_approval";
    if (findings.some((finding) => finding.code === "approval_scope_mismatch")) {
        return "needs_user_decision";
    }
    return "completed";
}
export async function runGoal(options) {
    const requestPath = resolve(options.requestPath);
    const request = JSON.parse(await readFile(requestPath, "utf8"));
    const stateRoot = options.stateRoot || defaultStateRoot();
    const now = options.now || new Date();
    const createdAt = now.toISOString();
    const runId = createRunId(`goal-${request.goal?.id || "request"}`, now);
    const artifactDir = await prepareRunDirectory(stateRoot, runId);
    const validationErrors = validateGoalRequest(request);
    const findings = collectPreExecutionFindings(request, validationErrors);
    const steps = [];
    const receipts = [];
    const failureArtifacts = [];
    let postExecutionVerification;
    let postExecutionEvidencePath;
    let postExecutionConvergence;
    let postExecutionConvRequestPath;
    let postConvergenceVerification;
    let postConvergenceEvidencePath;
    const events = [
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
        for (const executionStep of request.execution_plan?.steps || []) {
            const runner = getGoalCapabilityRunner(executionStep.capability);
            if (!runner) {
                status = "blocked";
                findings.push({
                    code: "goal_capability_runner_missing",
                    message: `No runner is registered for approved execution step capability: ${executionStep.capability}.`,
                    severity: "error",
                });
                events.push({
                    timestamp: createdAt,
                    run_id: runId,
                    event: "goal_capability_runner_missing",
                    status: "error",
                    details: { capability: executionStep.capability, execution_step_id: executionStep.id },
                });
                break;
            }
            const stepNumber = steps.length + 1;
            let execution;
            try {
                execution = await runner({ request, stateRoot, artifactDir, runId, createdAt });
            }
            catch (error) {
                status = "blocked";
                const message = error instanceof Error ? error.message : String(error);
                const artifactPath = error.artifact_path;
                const supportingArtifacts = error.supporting_artifacts;
                if (typeof artifactPath === "string")
                    failureArtifacts.push(artifactPath);
                if (Array.isArray(supportingArtifacts)) {
                    failureArtifacts.push(...supportingArtifacts.filter((value) => typeof value === "string"));
                }
                findings.push({
                    code: "goal_capability_runner_failed",
                    message: `Goal execution step ${executionStep.id} (${executionStep.capability}) failed: ${message}`,
                    severity: "error",
                });
                events.push({
                    timestamp: createdAt,
                    run_id: runId,
                    event: "goal_capability_runner_failed",
                    status: "error",
                    details: {
                        capability: executionStep.capability,
                        execution_step_id: executionStep.id,
                        message,
                        artifact_path: typeof artifactPath === "string" ? artifactPath : undefined,
                    },
                });
                break;
            }
            steps.push({
                step: stepNumber,
                execution_step_id: executionStep.id,
                capability: execution.capability,
                action_summary: execution.action_summary,
                artifact_path: execution.artifact_path,
                supporting_artifacts: execution.supporting_artifacts,
                receipt_recorded: true,
            });
            receipts.push({
                schema_version: "pilot.receipt.v0",
                action: execution.action,
                capability: execution.capability,
                run_id: runId,
                step: stepNumber,
                execution_step_id: executionStep.id,
                artifact_path: execution.artifact_path,
                status: "ok",
                scope: executionStep.scope,
                actor: "pilot.local",
                timestamp: createdAt,
                risk_class: executionStep.risk_class,
                approval_reference: request.approval?.reference,
                primary_proof: stepNumber === 1,
            });
            events.push({
                timestamp: createdAt,
                run_id: runId,
                event: "goal_step_completed",
                status: "ok",
                details: {
                    capability: execution.capability,
                    execution_step_id: executionStep.id,
                    approval_reference: request.approval?.reference,
                    ...execution.event_details,
                },
            });
            if (await pathExists(execution.artifact_path)) {
                findings.push({
                    code: "structural_evidence_sufficient",
                    message: execution.evidence_message,
                    severity: "info",
                });
                events.push({
                    timestamp: createdAt,
                    run_id: runId,
                    event: "goal_structural_evidence_checked",
                    status: "sufficient_evidence",
                    details: { artifact_path: execution.artifact_path, receipt_recorded: true },
                });
            }
            else {
                status = "needs_evidence";
                findings.push({
                    code: "goal_artifact_missing_after_execution",
                    message: `Goal artifact was expected but was not found after executing ${executionStep.capability}.`,
                    severity: "error",
                });
                break;
            }
        }
    }
    else {
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
    const createdFiles = [
        ...Object.values(files),
        ...steps.flatMap((step) => [step.artifact_path, ...(step.supporting_artifacts || [])]),
        ...failureArtifacts,
    ];
    const receiptsPath = join(artifactDir, "receipts.jsonl");
    if (receipts.length > 0) {
        createdFiles.push(receiptsPath);
        await writeFile(receiptsPath, receipts.map((receipt) => `${JSON.stringify(receipt)}\n`).join(""), "utf8");
    }
    if (status === "completed" && receipts.length > 0 && steps.length > 0) {
        postExecutionEvidencePath = join(artifactDir, "post-execution-evidence.json");
        const packet = buildPostExecutionEvidencePacket(request, runId, steps, receiptsPath);
        await writeJson(postExecutionEvidencePath, packet);
        postExecutionVerification = await runVerify({
            packetPath: postExecutionEvidencePath,
            stateRoot,
            now: new Date(now.getTime() + 1000),
        });
        createdFiles.push(postExecutionEvidencePath, ...postExecutionVerification.created_files);
        events.push({
            timestamp: createdAt,
            run_id: runId,
            event: "goal_post_execution_verify_completed",
            status: postExecutionVerification.verdict,
            details: {
                evidence_packet_path: postExecutionEvidencePath,
                verification_run_id: postExecutionVerification.run_id,
                verification_artifact_dir: postExecutionVerification.artifact_dir,
            },
        });
        if (postExecutionVerification.verdict === "sufficient_evidence") {
            findings.push({
                code: "post_execution_verification_sufficient",
                message: `Automatic deterministic verification passed: ${postExecutionVerification.run_id}.`,
                severity: "info",
            });
        }
        else {
            const convRequest = fixableVerificationVerdict(postExecutionVerification)
                ? buildPostExecutionConvRequest(request, runId, postExecutionEvidencePath, postExecutionVerification)
                : undefined;
            if (convRequest) {
                postExecutionConvRequestPath = join(artifactDir, "post-execution-conv-request.json");
                await writeJson(postExecutionConvRequestPath, convRequest);
                postExecutionConvergence = await runConv({
                    requestPath: postExecutionConvRequestPath,
                    stateRoot,
                    now: new Date(now.getTime() + 2000),
                });
                createdFiles.push(postExecutionConvRequestPath, ...postExecutionConvergence.created_files);
                events.push({
                    timestamp: createdAt,
                    run_id: runId,
                    event: "goal_post_execution_conv_completed",
                    status: postExecutionConvergence.status,
                    details: {
                        conv_request_path: postExecutionConvRequestPath,
                        conv_run_id: postExecutionConvergence.run_id,
                        conv_artifact_dir: postExecutionConvergence.artifact_dir,
                        rounds: postExecutionConvergence.rounds.length,
                    },
                });
                if (postExecutionConvergence.status === "completed") {
                    postConvergenceEvidencePath = join(artifactDir, "post-convergence-evidence.json");
                    await writeJson(postConvergenceEvidencePath, buildPostConvergenceEvidencePacket(request, runId, steps, receiptsPath, postExecutionConvergence));
                    postConvergenceVerification = await runVerify({
                        packetPath: postConvergenceEvidencePath,
                        stateRoot,
                        now: new Date(now.getTime() + 3000),
                    });
                    createdFiles.push(postConvergenceEvidencePath, ...postConvergenceVerification.created_files);
                    events.push({
                        timestamp: createdAt,
                        run_id: runId,
                        event: "goal_post_convergence_verify_completed",
                        status: postConvergenceVerification.verdict,
                        details: {
                            evidence_packet_path: postConvergenceEvidencePath,
                            verification_run_id: postConvergenceVerification.run_id,
                            verification_artifact_dir: postConvergenceVerification.artifact_dir,
                        },
                    });
                    if (postConvergenceVerification.verdict === "sufficient_evidence") {
                        status = "completed";
                        findings.push({
                            code: "post_convergence_verification_sufficient",
                            message: `Automatic bounded convergence and re-verification passed: ${postConvergenceVerification.run_id}.`,
                            severity: "info",
                        });
                    }
                    else {
                        status =
                            postConvergenceVerification.verdict === "missing_evidence"
                                ? "needs_evidence"
                                : postConvergenceVerification.verdict === "needs_revision" ||
                                    postConvergenceVerification.verdict === "insufficient_evidence"
                                    ? "needs_revision"
                                    : "blocked";
                        findings.push(...postConvergenceVerification.findings.map((finding) => ({
                            ...finding,
                            code: `post_convergence_${finding.code}`,
                            message: `Automatic post-convergence verification: ${finding.message}`,
                        })));
                    }
                }
                else {
                    status =
                        postExecutionConvergence.status === "needs_user_decision"
                            ? "needs_user_decision"
                            : postExecutionConvergence.status === "blocked"
                                ? "blocked"
                                : "needs_revision";
                    findings.push(...postExecutionConvergence.findings
                        .filter((finding) => finding.status === "open")
                        .map((finding) => ({
                        code: `post_execution_conv_${finding.id}`,
                        message: `Automatic post-execution convergence did not reduce finding: ${finding.description}`,
                        severity: "warning",
                    })));
                }
            }
            else {
                status =
                    postExecutionVerification.verdict === "missing_evidence"
                        ? "needs_evidence"
                        : postExecutionVerification.verdict === "needs_revision" ||
                            postExecutionVerification.verdict === "insufficient_evidence"
                            ? "needs_revision"
                            : "blocked";
                findings.push(...postExecutionVerification.findings.map((finding) => ({
                    ...finding,
                    code: `post_execution_${finding.code}`,
                    message: `Automatic post-execution verification: ${finding.message}`,
                })));
            }
        }
    }
    const result = {
        schema_version: "pilot.goal_run.v0",
        run_id: runId,
        status,
        request,
        steps,
        findings,
        post_execution_verification: postExecutionVerification && postExecutionEvidencePath
            ? {
                run_id: postExecutionVerification.run_id,
                verdict: postExecutionVerification.verdict,
                artifact_dir: postExecutionVerification.artifact_dir,
                evidence_packet_path: postExecutionEvidencePath,
            }
            : undefined,
        post_execution_convergence: postExecutionConvergence && postExecutionConvRequestPath
            ? {
                run_id: postExecutionConvergence.run_id,
                status: postExecutionConvergence.status,
                artifact_dir: postExecutionConvergence.artifact_dir,
                request_path: postExecutionConvRequestPath,
                rounds: postExecutionConvergence.rounds.length,
            }
            : undefined,
        post_convergence_verification: postConvergenceVerification && postConvergenceEvidencePath
            ? {
                run_id: postConvergenceVerification.run_id,
                verdict: postConvergenceVerification.verdict,
                artifact_dir: postConvergenceVerification.artifact_dir,
                evidence_packet_path: postConvergenceEvidencePath,
            }
            : undefined,
        created_at: createdAt,
        artifact_dir: artifactDir,
        created_files: createdFiles,
    };
    const lineage = await appendLineageRecord(stateRoot, {
        schema_version: "pilot.lineage.v0",
        created_at: createdAt,
        record_type: "run",
        command: "/goal",
        run_id: runId,
        short_run_id: shortRunId(runId),
        status,
        state_root: stateRoot,
        artifact_dir: artifactDir,
        parent_run_id: request.approval?.reference,
        approval_reference: request.approval?.reference,
        evidence_pointers: createdFiles,
        receipt_pointers: receipts.length > 0 ? [receiptsPath] : [],
        resume_hint: status === "completed"
            ? "Use receipts, goal-run.json, and final.md as proof for completion."
            : status === "awaiting_approval"
                ? "Approve the concrete plan before execution."
                : "Resolve the listed approval, evidence, scope, or runner issue before retrying /goal.",
        metadata: {
            capabilities: request.execution_plan ? executionPlanCapabilities(request.execution_plan).join(",") : "",
            execution_plan_hash: request.execution_plan?.approval_subject_hash || "",
            risk_class: request.preflight.risk_class,
            steps: String(steps.length),
        },
    });
    result.created_files = [...createdFiles, lineage.run_path];
    result.lifecycle = buildGoalLifecycleSummary(result);
    await writeJson(files.goalRun, result);
    await writeFile(files.events, events.map(eventLine).join(""), "utf8");
    await writeFile(files.final, renderGoalRunMarkdown(result), "utf8");
    return result;
}
