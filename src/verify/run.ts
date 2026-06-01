import { readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createRunId, eventLine, prepareRunDirectory, renderVerificationMarkdown, writeJson } from "../artifacts.ts";
import { defaultStateRoot } from "../config.ts";
import { validateEvidencePacket } from "../schema/index.ts";
import { appendLineageRecord } from "../state/lineage.ts";
import { shortRunId } from "../state/run-index.ts";
import type {
  EvidenceItem,
  EvidencePacket,
  EventRecord,
  VerificationFinding,
  VerificationResult,
  VerificationVerdict,
  SemanticVerificationVerdict,
  SpecializedReviewer,
} from "../types.ts";

export type RunVerifyOptions = {
  packetPath: string;
  stateRoot?: string;
  now?: Date;
};

function hasArtifactPath(item: EvidenceItem): item is EvidenceItem & { path: string } {
  return item.type === "artifact" && typeof item.path === "string" && item.path.trim().length > 0;
}

async function artifactExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function collectFindings(packet: EvidencePacket, packetPath: string): Promise<VerificationFinding[]> {
  const findings: VerificationFinding[] = validateEvidencePacket(packet).map((message) => ({
    code: "schema_invalid",
    message,
    severity: "error",
  }));

  if (findings.length > 0) return findings;

  const packetDir = resolve(packetPath, "..");
  for (const item of packet.evidence) {
    if (!item.in_scope) {
      findings.push({
        code: "evidence_out_of_scope",
        message: `Evidence is outside approved scope: ${item.id}`,
        severity: "error",
      });
    }

    if (hasArtifactPath(item)) {
      const artifactPath = isAbsolute(item.path) ? item.path : resolve(packetDir, item.path);
      if (!(await artifactExists(artifactPath))) {
        findings.push({
          code: "artifact_missing",
          message: `Artifact does not exist: ${item.id}`,
          severity: "error",
        });
      }
    }
  }

  const requiredCriteria = packet.verdict_criteria.filter((criterion) => criterion.required);
  for (const criterion of requiredCriteria) {
    const supportingEvidence = packet.evidence.filter(
      (item) => item.in_scope && item.supports_claim && item.criteria_ids.includes(criterion.id),
    );
    if (supportingEvidence.length === 0) {
      findings.push({
        code: "criterion_without_supporting_evidence",
        message: `Required criterion has no supporting in-scope evidence: ${criterion.id}`,
        severity: "error",
      });
    }
  }

  if (packet.evidence.length === 0) {
    findings.push({
      code: "evidence_missing",
      message: "Evidence packet has no evidence items.",
      severity: "error",
    });
  }

  const blockingStructuralFindings = findings.some((finding) => finding.severity === "error");
  if (!blockingStructuralFindings && packet.reviewer_boundary.semantic_review_required && (packet.specialized_reviewers || []).length < 2) {
    findings.push({
      code: "semantic_reviewers_missing",
      message: "Full semantic /verify requires at least two specialized reviewers; deterministic checks alone cannot produce the semantic verdict.",
      severity: "error",
    });
  }

  return findings;
}

function chooseVerdict(findings: VerificationFinding[]): VerificationVerdict {
  if (findings.some((finding) => finding.code === "schema_invalid")) return "blocked";
  if (findings.some((finding) => finding.code === "semantic_reviewers_missing")) return "blocked";
  if (findings.some((finding) => finding.code === "artifact_missing" || finding.code === "evidence_missing")) {
    return "missing_evidence";
  }
  if (findings.some((finding) => finding.code === "evidence_out_of_scope")) return "needs_revision";
  if (findings.some((finding) => finding.code === "criterion_without_supporting_evidence")) {
    return "insufficient_evidence";
  }
  return "sufficient_evidence";
}

function chooseSemanticVerdict(packet: EvidencePacket, findings: VerificationFinding[]): SemanticVerificationVerdict {
  if (!packet.reviewer_boundary.semantic_review_required) return "not_requested";
  if (findings.some((finding) => finding.code === "semantic_reviewers_missing")) return "incomplete";
  if (findings.some((finding) => finding.code === "schema_invalid")) return "blocked";
  if (findings.some((finding) => finding.severity === "error")) return "blocked";

  const reviewers = packet.specialized_reviewers || [];
  if (reviewers.some((reviewer) => reviewer.verdict === "blocked")) return "blocked";
  if (reviewers.some((reviewer) => reviewer.verdict === "fail")) return "fail";
  if (reviewers.some((reviewer) => reviewer.verdict === "needs_revision")) return "needs_revision";
  if (reviewers.some((reviewer) => reviewer.verdict === "pass_with_risks" || reviewer.confidence === "low")) {
    return "pass_with_risks";
  }
  return "pass";
}

function reviewerSummary(packet: EvidencePacket, reviewers: SpecializedReviewer[]): VerificationResult["reviewer_summary"] {
  if (!packet.reviewer_boundary.semantic_review_required) {
    return {
      required: false,
      reviewer_count: reviewers.length,
      minimum_required: 0,
      status: "not_requested",
    };
  }

  return {
    required: true,
    reviewer_count: reviewers.length,
    minimum_required: 2,
    status: reviewers.length >= 2 ? "completed" : "missing_reviewers",
  };
}

export async function runVerify(options: RunVerifyOptions): Promise<VerificationResult> {
  const packetPath = resolve(options.packetPath);
  const packet = JSON.parse(await readFile(packetPath, "utf8")) as EvidencePacket;
  const stateRoot = options.stateRoot || defaultStateRoot();
  const now = options.now || new Date();
  const createdAt = now.toISOString();
  const runId = createRunId(`verify-${packet.claim?.id || "packet"}`, now);
  const artifactDir = await prepareRunDirectory(stateRoot, runId);
  const findings = await collectFindings(packet, packetPath);
  const verdict = chooseVerdict(findings);
  const reviewers = packet.specialized_reviewers || [];
  const semanticVerdict = chooseSemanticVerdict(packet, findings);

  const files = {
    verification: join(artifactDir, "verification.json"),
    events: join(artifactDir, "events.jsonl"),
    final: join(artifactDir, "final.md"),
  };

  const result: VerificationResult = {
    schema_version: "pilot.verification.v0",
    run_id: runId,
    packet,
    verdict,
    semantic_verdict: semanticVerdict,
    reviewer_summary: reviewerSummary(packet, reviewers),
    findings,
    created_at: createdAt,
    artifact_dir: artifactDir,
    created_files: Object.values(files),
  };

  const events: EventRecord[] = [
    {
      timestamp: createdAt,
      run_id: runId,
      event: "verify_packet_loaded",
      status: "ok",
      details: { packet_path: packetPath },
    },
    {
      timestamp: createdAt,
      run_id: runId,
      event: "verify_completed",
      status: verdict,
      details: { semantic_judgment: semanticVerdict },
    },
  ];

  await writeJson(files.verification, result);
  await writeFile(files.events, events.map(eventLine).join(""), "utf8");
  await writeFile(files.final, renderVerificationMarkdown(result), "utf8");
  const lineage = await appendLineageRecord(stateRoot, {
    schema_version: "pilot.lineage.v0",
    created_at: createdAt,
    record_type: "run",
    command: "/verify",
    run_id: runId,
    short_run_id: shortRunId(runId),
    status: verdict,
    state_root: stateRoot,
    artifact_dir: artifactDir,
    evidence_pointers: Object.values(files),
    resume_hint:
      verdict === "sufficient_evidence"
        ? "Use verification.json and final.md as proof for the claim."
        : "Revise evidence or run /conv against fixable findings before re-verifying.",
    metadata: {
      claim_id: String(packet.claim?.id || ""),
      profile: String(packet.claim?.profile || ""),
    },
  });
  result.created_files = [...Object.values(files), lineage.run_path];
  await writeJson(files.verification, result);

  return result;
}
