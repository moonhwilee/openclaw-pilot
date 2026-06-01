import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { writeJson } from "../artifacts.js";
import { listRecoveryRuns } from "../state/recovery.js";
const recentAliases = new Set(["recent", "latest", "last", "최근", "마지막", "방금", "최신"]);
function firstToken(value) {
    return value.trim().split(/\s+/)[0] || "";
}
export function looksLikeRunReference(value) {
    return /^\d{6}$/.test(value) || /^\d{8}T\d{6}Z-[a-z0-9가-힣-]+$/.test(value);
}
function looksLikeJsonPath(value) {
    const trimmed = value.trim();
    return /^[^\s]+\.json$/i.test(trimmed);
}
async function pathExists(path) {
    try {
        const info = await stat(path);
        return info.isFile();
    }
    catch {
        return false;
    }
}
export async function resolveCommandTarget(raw) {
    const rest = raw.trim();
    if (!rest)
        return { kind: "empty", raw: rest };
    if (looksLikeJsonPath(rest)) {
        return (await pathExists(rest))
            ? { kind: "json_path_existing", raw: rest, path: rest }
            : { kind: "json_path_missing", raw: rest, path: rest };
    }
    const token = firstToken(rest);
    if (looksLikeRunReference(token))
        return { kind: "run_reference", raw: rest, reference: token };
    if (recentAliases.has(token.toLowerCase()))
        return { kind: "recent_alias", raw: rest, alias: token };
    return { kind: "natural_language", raw: rest, text: rest };
}
export async function latestRecoveryRun(stateRoot) {
    return (await listRecoveryRuns(stateRoot, 1))[0];
}
export function findingPriority(finding) {
    if (finding.priority)
        return finding.priority;
    return finding.severity === "warning" ? "P3" : "P2";
}
export function buildEvidencePacketFromRun(run, statement) {
    const artifactPaths = [
        ...("available_artifacts" in run ? run.available_artifacts : []),
        ...("evidence_pointers" in run ? run.evidence_pointers || [] : []),
    ];
    const uniqueArtifacts = [...new Set(artifactPaths)].filter((path) => path.trim().length > 0);
    return {
        schema_version: "pilot.evidence.v0",
        claim: {
            id: `run-${run.short_run_id}`,
            statement,
            profile: "document_strategy",
        },
        verdict_criteria: [
            {
                id: "run_artifacts_exist",
                description: "The referenced Pilot run has durable artifacts that can support the verification claim.",
                required: true,
            },
        ],
        evidence: uniqueArtifacts.map((path, index) => ({
            id: `artifact-${index + 1}`,
            type: "artifact",
            description: `Pilot artifact from ${run.short_run_id}: ${basename(path)}`,
            criteria_ids: ["run_artifacts_exist"],
            supports_claim: true,
            in_scope: true,
            path,
        })),
        reviewer_boundary: {
            semantic_review_required: false,
            deterministic_checks_only: true,
        },
    };
}
export async function writeEvidencePacketForRun(run, statement) {
    const packet = buildEvidencePacketFromRun(run, statement);
    if (packet.evidence.length === 0)
        return undefined;
    const packetPath = join(run.artifact_dir, "natural-verify-evidence-packet.json");
    await writeJson(packetPath, packet);
    return packetPath;
}
export function buildConvRequestFromVerification(run, verification, naturalRequest) {
    const findings = verification.findings
        .filter((finding) => finding.severity !== "info")
        .map((finding, index) => ({
        id: `${finding.code || "finding"}-${index + 1}`,
        description: finding.message,
        status: "open",
        priority: findingPriority(finding),
    }));
    if (findings.length === 0)
        return undefined;
    const artifactPaths = "available_artifacts" in run ? run.available_artifacts : [];
    const anchorPath = artifactPaths.find((path) => path.endsWith("verification.json")) ||
        artifactPaths.find((path) => path.endsWith("final.md")) ||
        artifactPaths[0];
    return {
        schema_version: "pilot.conv_request.v0",
        anchor: {
            id: `run-${run.short_run_id}`,
            ...(anchorPath ? { path: anchorPath } : {}),
            description: `Natural /conv target for ${run.short_run_id}: ${naturalRequest}`,
        },
        findings,
        preflight: {
            risk_class: "low",
            allowed_capabilities: ["local_artifact_note", "finding_status_update"],
            forbidden_capabilities: ["external_message", "deploy", "credential_access", "shell_execution", "telegram_routing"],
            max_rounds: 2,
            stop_condition: "all_findings_reduced",
        },
    };
}
export async function writeConvRequestFromVerification(run, verification, naturalRequest) {
    const request = buildConvRequestFromVerification(run, verification, naturalRequest);
    if (!request)
        return undefined;
    const requestPath = join(run.artifact_dir, "natural-conv-request.json");
    await writeJson(requestPath, request);
    return requestPath;
}
