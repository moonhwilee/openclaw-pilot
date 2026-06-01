import { readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createRunId, eventLine, prepareRunDirectory, renderConvMarkdown, writeJson } from "../artifacts.js";
import { defaultStateRoot } from "../config.js";
import { validateConvRequest } from "../schema/index.js";
import { appendLineageRecord } from "../state/lineage.js";
import { shortRunId } from "../state/run-index.js";
function needsApproval(request) {
    return request.preflight.risk_class !== "low";
}
function findingPriority(finding) {
    return finding.priority || "P2";
}
function hasBlockingOpenFindings(findings) {
    return findings.some((finding) => finding.status === "open" && findingPriority(finding) !== "P3");
}
function nextOpenBlockingFinding(findings) {
    return findings.find((finding) => finding.status === "open" && findingPriority(finding) !== "P3");
}
function openFindingRisks(findings) {
    return findings
        .filter((finding) => finding.status === "open")
        .map((finding) => `${finding.id}: ${finding.description}`);
}
function nextRoundNumber(rounds) {
    return rounds.reduce((max, round) => Math.max(max, round.round), 0) + 1;
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
async function writeConvCheckpoint(path, checkpoint, now) {
    await writeJson(path, {
        schema_version: "pilot.conv_checkpoint.v0",
        updated_at: now.toISOString(),
        ...checkpoint,
    });
}
async function validateRequest(request, requestDir) {
    const validationErrors = validateConvRequest(request);
    if (request.anchor?.path?.trim()) {
        const anchorPath = isAbsolute(request.anchor.path) ? request.anchor.path : resolve(requestDir, request.anchor.path);
        if (!(await pathExists(anchorPath))) {
            validationErrors.push(`anchor path does not exist: ${request.anchor.path}`);
        }
    }
    return validationErrors;
}
async function finalizeConvRun(options) {
    const files = {
        request: options.requestArtifactPath,
        checkpoint: options.checkpointPath,
        conv: join(options.artifactDir, "conv.json"),
        receipts: join(options.artifactDir, "receipts.jsonl"),
        events: join(options.artifactDir, "events.jsonl"),
        final: join(options.artifactDir, "final.md"),
    };
    await writeConvCheckpoint(files.checkpoint, {
        run_id: options.runId,
        status: options.checkpointStatus,
        request: options.request,
        findings: options.findings,
        rounds: options.rounds,
        next_round: nextRoundNumber(options.rounds),
        max_rounds: options.request.preflight.max_rounds,
        artifact_dir: options.artifactDir,
    }, new Date(options.createdAt));
    const result = {
        schema_version: "pilot.conv.v0",
        run_id: options.runId,
        status: options.status,
        anchor: options.request.anchor,
        findings: options.findings,
        rounds: options.rounds,
        created_at: options.createdAt,
        artifact_dir: options.artifactDir,
        created_files: [...Object.values(files), ...options.rounds.map((round) => round.evidence_update)],
    };
    const lineage = await appendLineageRecord(options.stateRoot, {
        schema_version: "pilot.lineage.v0",
        created_at: options.createdAt,
        record_type: "run",
        command: "/conv",
        run_id: options.runId,
        short_run_id: shortRunId(options.runId),
        status: options.status,
        state_root: options.stateRoot,
        artifact_dir: options.artifactDir,
        evidence_pointers: [...Object.values(files), ...options.rounds.map((round) => round.evidence_update)],
        receipt_pointers: [files.receipts],
        resume_hint: options.status === "completed"
            ? "Use the convergence artifacts as updated evidence, then run /verify if a final verdict is needed."
            : "Use resume <Run> to continue from conv-checkpoint.json, or provide a safer anchor/user decision before retrying.",
        metadata: {
            anchor_id: options.request.anchor?.id || "",
            rounds: String(options.rounds.length),
            checkpoint_path: files.checkpoint,
            ...(options.checkpointStatus === "running" ? { last_progress_at: options.createdAt } : {}),
        },
    });
    result.created_files = [...result.created_files, lineage.run_path];
    await writeJson(files.request, options.request);
    await writeJson(files.conv, result);
    await writeFile(files.receipts, options.receipts.map((receipt) => `${JSON.stringify(receipt)}\n`).join(""), "utf8");
    await writeFile(files.events, options.events.map(eventLine).join(""), "utf8");
    await writeFile(files.final, renderConvMarkdown(result), "utf8");
    return result;
}
async function continueConvRun(options) {
    const receipts = options.rounds.map((round) => ({
        schema_version: "pilot.receipt.v0",
        action: "create_local_evidence_update",
        capability: "local_artifact_note",
        run_id: options.runId,
        round: round.round,
        artifact_path: round.evidence_update,
        status: "ok",
    }));
    const validationErrors = await validateRequest(options.request, options.requestDir);
    let status;
    if (validationErrors.length > 0) {
        status = validationErrors.some((error) => error.includes("missing anchor")) ? "blocked" : "needs_user_decision";
        options.events.push({
            timestamp: options.createdAt,
            run_id: options.runId,
            event: "conv_preflight_failed",
            status,
            details: { validation_errors: validationErrors },
        });
    }
    else if (needsApproval(options.request)) {
        status = "needs_user_decision";
        options.events.push({
            timestamp: options.createdAt,
            run_id: options.runId,
            event: "conv_approval_required",
            status,
            details: { risk_class: options.request.preflight.risk_class },
        });
    }
    else {
        for (let round = nextRoundNumber(options.rounds); round <= options.request.preflight.max_rounds && hasBlockingOpenFindings(options.findings); round += 1) {
            const finding = nextOpenBlockingFinding(options.findings);
            if (!finding)
                break;
            const evidenceUpdate = join(options.artifactDir, `round-${round}-evidence-update.md`);
            await writeFile(evidenceUpdate, [
                "# Conv Evidence Update",
                "",
                `Anchor: ${options.request.anchor.id}`,
                `Finding: ${finding.id}`,
                "",
                "Local-only update produced by bounded convergence.",
                "",
            ].join("\n"), "utf8");
            finding.status = "reduced";
            const remainingRisks = openFindingRisks(options.findings);
            options.rounds.push({
                round,
                finding_ids: [finding.id],
                action_summary: `Reduced finding ${finding.id} with a local evidence update.`,
                evidence_update: evidenceUpdate,
                verdict: "reduced",
                summary: {
                    target_reviewed: options.request.anchor.path || options.request.anchor.description || options.request.anchor.id,
                    prior_issue_resolution: `Reduced existing finding ${finding.id}.`,
                    new_issues: [],
                    delta_summary: `Added local evidence update ${evidenceUpdate}.`,
                    remaining_risks: remainingRisks.length ? remainingRisks : ["none"],
                    next_action: remainingRisks.length ? "continue" : "complete",
                },
            });
            receipts.push({
                schema_version: "pilot.receipt.v0",
                action: "create_local_evidence_update",
                capability: "local_artifact_note",
                run_id: options.runId,
                round,
                artifact_path: evidenceUpdate,
                status: "ok",
            });
            await writeConvCheckpoint(options.checkpointPath, {
                run_id: options.runId,
                status: "running",
                request: options.request,
                findings: options.findings,
                rounds: options.rounds,
                next_round: round + 1,
                max_rounds: options.request.preflight.max_rounds,
                artifact_dir: options.artifactDir,
            }, new Date(options.createdAt));
        }
        status = hasBlockingOpenFindings(options.findings) ? "max_rounds_reached" : "completed";
        options.events.push({
            timestamp: options.createdAt,
            run_id: options.runId,
            event: "conv_completed",
            status,
            details: { rounds: options.rounds.length },
        });
    }
    return finalizeConvRun({
        stateRoot: options.stateRoot,
        request: options.request,
        requestPath: options.requestPath,
        runId: options.runId,
        artifactDir: options.artifactDir,
        createdAt: options.createdAt,
        status,
        findings: options.findings,
        rounds: options.rounds,
        receipts,
        events: options.events,
        checkpointPath: options.checkpointPath,
        requestArtifactPath: options.requestArtifactPath,
        checkpointStatus: status === "completed" || status === "max_rounds_reached" ? "completed" : "running",
    });
}
export async function runConv(options) {
    const requestPath = resolve(options.requestPath);
    const request = JSON.parse(await readFile(requestPath, "utf8"));
    const requestDir = resolve(requestPath, "..");
    const stateRoot = options.stateRoot || defaultStateRoot();
    const now = options.now || new Date();
    const createdAt = now.toISOString();
    const runId = createRunId(`conv-${request.anchor?.id || "request"}`, now);
    const artifactDir = await prepareRunDirectory(stateRoot, runId);
    const checkpointPath = join(artifactDir, "conv-checkpoint.json");
    const requestArtifactPath = join(artifactDir, "conv-request.json");
    const findings = (request.findings || []).map((finding) => ({ ...finding }));
    const rounds = [];
    const events = [
        {
            timestamp: createdAt,
            run_id: runId,
            event: "conv_request_loaded",
            status: "ok",
            details: { request_path: requestPath },
        },
    ];
    await writeJson(requestArtifactPath, request);
    await writeConvCheckpoint(checkpointPath, {
        run_id: runId,
        status: "running",
        request,
        findings,
        rounds,
        next_round: 1,
        max_rounds: request.preflight.max_rounds,
        artifact_dir: artifactDir,
    }, now);
    await appendLineageRecord(stateRoot, {
        schema_version: "pilot.lineage.v0",
        created_at: createdAt,
        record_type: "run",
        command: "/conv",
        run_id: runId,
        short_run_id: shortRunId(runId),
        status: "running",
        state_root: stateRoot,
        artifact_dir: artifactDir,
        evidence_pointers: [requestArtifactPath, checkpointPath],
        receipt_pointers: [],
        resume_hint: "Use resume <Run> to continue standalone /conv from conv-checkpoint.json if this run is interrupted.",
        metadata: {
            anchor_id: request.anchor?.id || "",
            checkpoint_path: checkpointPath,
            last_progress_at: createdAt,
        },
    });
    return continueConvRun({
        stateRoot,
        request,
        requestDir,
        requestPath,
        runId,
        artifactDir,
        createdAt,
        findings,
        rounds,
        checkpointPath,
        requestArtifactPath,
        events,
    });
}
export async function resumeConvFromCheckpoint(options) {
    const checkpointPath = resolve(options.checkpointPath);
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    if (checkpoint.schema_version !== "pilot.conv_checkpoint.v0") {
        throw new Error("conv checkpoint artifact is invalid");
    }
    if (checkpoint.status === "completed") {
        throw new Error("conv checkpoint is already completed");
    }
    const stateRoot = options.stateRoot || defaultStateRoot();
    const now = options.now || new Date();
    const createdAt = now.toISOString();
    const requestArtifactPath = join(checkpoint.artifact_dir, "conv-request.json");
    const events = [
        {
            timestamp: createdAt,
            run_id: checkpoint.run_id,
            event: "conv_resume_checkpoint_loaded",
            status: "ok",
            details: {
                checkpoint_path: checkpointPath,
                completed_rounds: checkpoint.rounds.length,
                next_round: checkpoint.next_round,
            },
        },
    ];
    return continueConvRun({
        stateRoot,
        request: checkpoint.request,
        requestDir: checkpoint.artifact_dir,
        runId: checkpoint.run_id,
        artifactDir: checkpoint.artifact_dir,
        createdAt,
        findings: checkpoint.findings.map((finding) => ({ ...finding })),
        rounds: checkpoint.rounds.map((round) => ({ ...round })),
        checkpointPath,
        requestArtifactPath,
        events,
    });
}
