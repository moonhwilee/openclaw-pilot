import { readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createRunId, eventLine, prepareRunDirectory, renderConvMarkdown, writeJson } from "../artifacts.js";
import { defaultStateRoot } from "../config.js";
import { validateConvRequest } from "../schema/index.js";
function needsApproval(request) {
    return request.preflight.risk_class !== "low";
}
function hasOpenFindings(findings) {
    return findings.some((finding) => finding.status === "open");
}
function nextOpenFinding(findings) {
    return findings.find((finding) => finding.status === "open");
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
export async function runConv(options) {
    const requestPath = resolve(options.requestPath);
    const request = JSON.parse(await readFile(requestPath, "utf8"));
    const requestDir = resolve(requestPath, "..");
    const stateRoot = options.stateRoot || defaultStateRoot();
    const now = options.now || new Date();
    const createdAt = now.toISOString();
    const runId = createRunId(`conv-${request.anchor?.id || "request"}`, now);
    const artifactDir = await prepareRunDirectory(stateRoot, runId);
    const findings = (request.findings || []).map((finding) => ({ ...finding }));
    const rounds = [];
    const receipts = [];
    const events = [
        {
            timestamp: createdAt,
            run_id: runId,
            event: "conv_request_loaded",
            status: "ok",
            details: { request_path: requestPath },
        },
    ];
    const validationErrors = validateConvRequest(request);
    if (request.anchor?.path?.trim()) {
        const anchorPath = isAbsolute(request.anchor.path) ? request.anchor.path : resolve(requestDir, request.anchor.path);
        if (!(await pathExists(anchorPath))) {
            validationErrors.push(`anchor path does not exist: ${request.anchor.path}`);
        }
    }
    let status;
    if (validationErrors.length > 0) {
        status = validationErrors.some((error) => error.includes("missing anchor")) ? "blocked" : "needs_user_decision";
        events.push({
            timestamp: createdAt,
            run_id: runId,
            event: "conv_preflight_failed",
            status,
            details: { validation_errors: validationErrors },
        });
    }
    else if (needsApproval(request)) {
        status = "needs_user_decision";
        events.push({
            timestamp: createdAt,
            run_id: runId,
            event: "conv_approval_required",
            status,
            details: { risk_class: request.preflight.risk_class },
        });
    }
    else {
        for (let round = 1; round <= request.preflight.max_rounds && hasOpenFindings(findings); round += 1) {
            const finding = nextOpenFinding(findings);
            if (!finding)
                break;
            const evidenceUpdate = join(artifactDir, `round-${round}-evidence-update.md`);
            await writeFile(evidenceUpdate, [
                "# Conv Evidence Update",
                "",
                `Anchor: ${request.anchor.id}`,
                `Finding: ${finding.id}`,
                "",
                "Local-only update produced by bounded convergence.",
                "",
            ].join("\n"), "utf8");
            finding.status = "reduced";
            rounds.push({
                round,
                finding_ids: [finding.id],
                action_summary: `Reduced finding ${finding.id} with a local evidence update.`,
                evidence_update: evidenceUpdate,
                verdict: "reduced",
            });
            receipts.push({
                schema_version: "pilot.receipt.v0",
                action: "create_local_evidence_update",
                capability: "local_artifact_note",
                run_id: runId,
                round,
                artifact_path: evidenceUpdate,
                status: "ok",
            });
        }
        status = hasOpenFindings(findings) ? "max_rounds_reached" : "completed";
        events.push({
            timestamp: createdAt,
            run_id: runId,
            event: "conv_completed",
            status,
            details: { rounds: rounds.length },
        });
    }
    const files = {
        conv: join(artifactDir, "conv.json"),
        receipts: join(artifactDir, "receipts.jsonl"),
        events: join(artifactDir, "events.jsonl"),
        final: join(artifactDir, "final.md"),
    };
    const result = {
        schema_version: "pilot.conv.v0",
        run_id: runId,
        status,
        anchor: request.anchor,
        findings,
        rounds,
        created_at: createdAt,
        artifact_dir: artifactDir,
        created_files: [...Object.values(files), ...rounds.map((round) => round.evidence_update)],
    };
    await writeJson(files.conv, result);
    await writeFile(files.receipts, receipts.map((receipt) => `${JSON.stringify(receipt)}\n`).join(""), "utf8");
    await writeFile(files.events, events.map(eventLine).join(""), "utf8");
    await writeFile(files.final, renderConvMarkdown(result), "utf8");
    return result;
}
