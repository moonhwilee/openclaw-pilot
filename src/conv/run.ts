import { readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createRunId, eventLine, prepareRunDirectory, renderConvMarkdown, writeJson } from "../artifacts.ts";
import { defaultStateRoot } from "../config.ts";
import { validateConvRequest } from "../schema/index.ts";
import { appendLineageRecord } from "../state/lineage.ts";
import { shortRunId } from "../state/run-index.ts";
import type { ConvFinding, ConvRequest, ConvResult, ConvRound, EventRecord, TypedReceipt } from "../types.ts";

export type RunConvOptions = {
  requestPath: string;
  stateRoot?: string;
  now?: Date;
};

function needsApproval(request: ConvRequest): boolean {
  return request.preflight.risk_class !== "low";
}

function hasOpenFindings(findings: ConvFinding[]): boolean {
  return findings.some((finding) => finding.status === "open");
}

function nextOpenFinding(findings: ConvFinding[]): ConvFinding | undefined {
  return findings.find((finding) => finding.status === "open");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function runConv(options: RunConvOptions): Promise<ConvResult> {
  const requestPath = resolve(options.requestPath);
  const request = JSON.parse(await readFile(requestPath, "utf8")) as ConvRequest;
  const requestDir = resolve(requestPath, "..");
  const stateRoot = options.stateRoot || defaultStateRoot();
  const now = options.now || new Date();
  const createdAt = now.toISOString();
  const runId = createRunId(`conv-${request.anchor?.id || "request"}`, now);
  const artifactDir = await prepareRunDirectory(stateRoot, runId);
  const findings = (request.findings || []).map((finding) => ({ ...finding }));
  const rounds: ConvRound[] = [];
  const receipts: TypedReceipt[] = [];
  const events: EventRecord[] = [
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
  let status: ConvResult["status"];

  if (validationErrors.length > 0) {
    status = validationErrors.some((error) => error.includes("missing anchor")) ? "blocked" : "needs_user_decision";
    events.push({
      timestamp: createdAt,
      run_id: runId,
      event: "conv_preflight_failed",
      status,
      details: { validation_errors: validationErrors },
    });
  } else if (needsApproval(request)) {
    status = "needs_user_decision";
    events.push({
      timestamp: createdAt,
      run_id: runId,
      event: "conv_approval_required",
      status,
      details: { risk_class: request.preflight.risk_class },
    });
  } else {
    for (let round = 1; round <= request.preflight.max_rounds && hasOpenFindings(findings); round += 1) {
      const finding = nextOpenFinding(findings);
      if (!finding) break;

      const evidenceUpdate = join(artifactDir, `round-${round}-evidence-update.md`);
      await writeFile(
        evidenceUpdate,
        [
          "# Conv Evidence Update",
          "",
          `Anchor: ${request.anchor.id}`,
          `Finding: ${finding.id}`,
          "",
          "Local-only update produced by bounded convergence.",
          "",
        ].join("\n"),
        "utf8",
      );
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

  const result: ConvResult = {
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

  const lineage = await appendLineageRecord(stateRoot, {
    schema_version: "pilot.lineage.v0",
    created_at: createdAt,
    record_type: "run",
    command: "/conv",
    run_id: runId,
    short_run_id: shortRunId(runId),
    status,
    state_root: stateRoot,
    artifact_dir: artifactDir,
    evidence_pointers: [...Object.values(files), ...rounds.map((round) => round.evidence_update)],
    receipt_pointers: [files.receipts],
    resume_hint:
      status === "completed"
        ? "Use the convergence artifacts as updated evidence, then run /verify if a final verdict is needed."
        : "Provide a safer or tighter anchor, more evidence, or a user decision before retrying /conv.",
    metadata: {
      anchor_id: request.anchor?.id || "",
      rounds: String(rounds.length),
    },
  });
  result.created_files = [...result.created_files, lineage.run_path];

  await writeJson(files.conv, result);
  await writeFile(files.receipts, receipts.map((receipt) => `${JSON.stringify(receipt)}\n`).join(""), "utf8");
  await writeFile(files.events, events.map(eventLine).join(""), "utf8");
  await writeFile(files.final, renderConvMarkdown(result), "utf8");

  return result;
}
