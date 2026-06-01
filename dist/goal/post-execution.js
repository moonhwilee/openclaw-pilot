function postExecutionExtraCriteria(request) {
    return request.plan.verification_gates
        .filter((gate) => /convergence|수렴/i.test(gate))
        .map((gate, index) => ({
        id: `convergence_note_${index + 1}`,
        description: gate,
        required: true,
    }));
}
function basePostExecutionCriteria() {
    return [
        {
            id: "approved_execution",
            description: "At least one approved execution artifact exists.",
            required: true,
        },
        {
            id: "runner_artifacts",
            description: "Runner or capability output artifacts exist.",
            required: true,
        },
        {
            id: "typed_receipt",
            description: "Typed receipt evidence exists for the executed capability.",
            required: true,
        },
    ];
}
export function fixableVerificationVerdict(result) {
    return result.verdict === "insufficient_evidence" || result.verdict === "needs_revision";
}
function verificationFindingsToConvFindings(result) {
    return result.findings
        .filter((finding) => finding.severity !== "info")
        .map((finding, index) => ({
        id: `post-execution-${index + 1}-${finding.code}`,
        description: finding.message,
        status: "open",
    }));
}
export function buildPostExecutionConvRequest(request, runId, postExecutionEvidencePath, verification) {
    const findings = verificationFindingsToConvFindings(verification);
    if (findings.length === 0)
        return undefined;
    return {
        schema_version: "pilot.conv_request.v0",
        anchor: {
            id: `goal-${runId}-post-execution`,
            path: postExecutionEvidencePath,
            description: "Automatic bounded convergence against post-execution verification findings.",
        },
        findings,
        preflight: {
            risk_class: "low",
            allowed_capabilities: ["local_artifact_note"],
            forbidden_capabilities: [
                "external_message",
                "shell_execution",
                "agent_spawn",
                "deploy",
                "server_restart",
                "destructive_filesystem",
            ],
            max_rounds: Math.max(1, Math.min(request.preflight.max_rounds || 1, 2)),
            stop_condition: "all_findings_reduced",
        },
    };
}
export function buildPostExecutionEvidencePacket(request, runId, steps, receiptsPath) {
    const evidence = steps.flatMap((step) => [
        {
            id: `step-${step.step}-artifact`,
            type: "artifact",
            description: `Primary artifact for step ${step.step}: ${step.capability}.`,
            criteria_ids: ["runner_artifacts", "approved_execution"],
            supports_claim: true,
            in_scope: true,
            path: step.artifact_path,
        },
        ...(step.supporting_artifacts || []).map((path, index) => ({
            id: `step-${step.step}-support-${index + 1}`,
            type: "artifact",
            description: `Supporting artifact ${index + 1} for step ${step.step}: ${step.capability}.`,
            criteria_ids: ["runner_artifacts"],
            supports_claim: true,
            in_scope: true,
            path,
        })),
    ]);
    evidence.push({
        id: "typed-receipts",
        type: "artifact",
        description: "Typed receipt file for the approved goal execution.",
        criteria_ids: ["typed_receipt"],
        supports_claim: true,
        in_scope: true,
        path: receiptsPath,
    });
    return {
        schema_version: "pilot.evidence.v0",
        claim: {
            id: `goal-${runId}`,
            statement: `Approved goal execution produced structural evidence for: ${request.goal.statement}`,
            profile: request.goal.profile,
        },
        verdict_criteria: [...basePostExecutionCriteria(), ...postExecutionExtraCriteria(request)],
        evidence,
        reviewer_boundary: {
            semantic_review_required: false,
            deterministic_checks_only: true,
        },
    };
}
export function buildPostConvergenceEvidencePacket(request, runId, steps, receiptsPath, convergence) {
    const packet = buildPostExecutionEvidencePacket(request, runId, steps, receiptsPath);
    const criteriaIds = packet.verdict_criteria.map((criterion) => criterion.id);
    return {
        ...packet,
        claim: {
            ...packet.claim,
            id: `${packet.claim.id}-post-convergence`,
            statement: `Approved goal execution plus bounded convergence produced structural evidence for: ${request.goal.statement}`,
        },
        evidence: [
            ...packet.evidence,
            ...convergence.rounds.map((round) => ({
                id: `conv-round-${round.round}-evidence-update`,
                type: "artifact",
                description: `Bounded convergence evidence update for round ${round.round}.`,
                criteria_ids: criteriaIds,
                supports_claim: true,
                in_scope: true,
                path: round.evidence_update,
            })),
        ],
    };
}
