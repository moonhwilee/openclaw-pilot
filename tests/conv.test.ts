import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { runConv } from "../src/conv/run.ts";
import { runVerify } from "../src/verify/run.ts";
import type { ConvRequest, EvidencePacket } from "../src/types.ts";

async function tempRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function baseConvRequest(): ConvRequest {
  return {
    schema_version: "pilot.conv_request.v0",
    anchor: {
      id: "fixture-anchor",
      description: "A bounded local fixture anchor.",
    },
    findings: [
      {
        id: "finding-one",
        description: "First bounded finding.",
        status: "open",
      },
    ],
    preflight: {
      risk_class: "low",
      allowed_capabilities: ["local_artifact_note", "finding_status_update"],
      forbidden_capabilities: ["external_message", "deploy", "credential_access", "shell_execution", "telegram_routing"],
      max_rounds: 2,
      stop_condition: "all_findings_reduced",
    },
  };
}

test("pilot conv refuses to run without an anchor", async () => {
  const root = await tempRoot("pilot-conv-");
  const stateRoot = await tempRoot("pilot-state-");
  const request = baseConvRequest();
  request.anchor.id = "";
  const requestPath = join(root, "conv.json");
  await writeJson(requestPath, request);

  const result = await runConv({
    requestPath,
    stateRoot,
    now: new Date("2026-06-01T00:00:00.000Z"),
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.rounds.length, 0);
});

test("pilot conv reduces low-risk findings and writes receipts", async () => {
  const root = await tempRoot("pilot-conv-");
  const stateRoot = await tempRoot("pilot-state-");
  const requestPath = join(root, "conv.json");
  await writeJson(requestPath, baseConvRequest());

  const result = await runConv({
    requestPath,
    stateRoot,
    now: new Date("2026-06-01T00:00:00.000Z"),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.findings[0].status, "reduced");
  assert.equal(result.rounds.length, 1);
  assert.ok(result.created_files.includes(result.rounds[0].evidence_update));
  assert.equal(await fileExists(join(result.artifact_dir, "conv.json")), true);
  assert.equal(await fileExists(join(result.artifact_dir, "conv-request.json")), true);
  assert.equal(await fileExists(join(result.artifact_dir, "conv-checkpoint.json")), true);
  assert.equal(await fileExists(join(result.artifact_dir, "receipts.jsonl")), true);
  assert.equal(await fileExists(join(result.artifact_dir, "lineage.jsonl")), true);
  assert.equal(await fileExists(join(stateRoot, "index", "lineage.jsonl")), true);

  const receipts = await readFile(join(result.artifact_dir, "receipts.jsonl"), "utf8");
  assert.match(receipts, /"schema_version":"pilot.receipt.v0"/);
  assert.match(receipts, /"capability":"local_artifact_note"/);
  const lineage = await readFile(join(result.artifact_dir, "lineage.jsonl"), "utf8");
  assert.ok(lineage.includes('"command":"/conv"'));
  assert.ok(lineage.includes('"status":"running"'));
  assert.ok(lineage.includes('"status":"completed"'));
  assert.match(lineage, /"receipt_pointers":/);
  const checkpoint = JSON.parse(await readFile(join(result.artifact_dir, "conv-checkpoint.json"), "utf8"));
  assert.equal(checkpoint.schema_version, "pilot.conv_checkpoint.v0");
  assert.equal(checkpoint.status, "completed");
  assert.equal(checkpoint.rounds.length, 1);
});

test("pilot conv blocks missing anchor paths", async () => {
  const root = await tempRoot("pilot-conv-");
  const stateRoot = await tempRoot("pilot-state-");
  const request = baseConvRequest();
  request.anchor.path = "missing-anchor.json";
  const requestPath = join(root, "conv.json");
  await writeJson(requestPath, request);

  const result = await runConv({
    requestPath,
    stateRoot,
    now: new Date("2026-06-01T00:00:00.000Z"),
  });

  assert.equal(result.status, "needs_user_decision");
  assert.equal(result.rounds.length, 0);
});

test("pilot conv stops at max rounds when findings remain", async () => {
  const root = await tempRoot("pilot-conv-");
  const stateRoot = await tempRoot("pilot-state-");
  const request = baseConvRequest();
  request.preflight.max_rounds = 1;
  request.findings.push({
    id: "finding-two",
    description: "Second bounded finding.",
    status: "open",
  });
  const requestPath = join(root, "conv.json");
  await writeJson(requestPath, request);

  const result = await runConv({
    requestPath,
    stateRoot,
    now: new Date("2026-06-01T00:00:00.000Z"),
  });

  assert.equal(result.status, "max_rounds_reached");
  assert.equal(result.rounds.length, 1);
  assert.ok(result.findings.some((finding) => finding.status === "open"));
});

test("pilot conv asks for approval on ambiguous higher-risk requests", async () => {
  const root = await tempRoot("pilot-conv-");
  const stateRoot = await tempRoot("pilot-state-");
  const request = baseConvRequest();
  request.preflight.risk_class = "medium";
  const requestPath = join(root, "conv.json");
  await writeJson(requestPath, request);

  const result = await runConv({
    requestPath,
    stateRoot,
    now: new Date("2026-06-01T00:00:00.000Z"),
  });

  assert.equal(result.status, "needs_user_decision");
  assert.equal(result.rounds.length, 0);
});

test("pilot conv rejects forbidden or unsupported capabilities", async () => {
  const root = await tempRoot("pilot-conv-");
  const stateRoot = await tempRoot("pilot-state-");
  const request = baseConvRequest();
  request.preflight.allowed_capabilities = ["shell_execution"];
  const requestPath = join(root, "conv.json");
  await writeJson(requestPath, request);

  const result = await runConv({
    requestPath,
    stateRoot,
    now: new Date("2026-06-01T00:00:00.000Z"),
  });

  assert.equal(result.status, "needs_user_decision");
  assert.equal(result.rounds.length, 0);
});

test("pilot conv fixture can be run from the repository", () => {
  const result = spawnSync(process.execPath, ["src/cli.ts", "conv", "fixtures/document_strategy/conv-request.json"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "completed");
  assert.equal(output.rounds.length, 1);
});

test("verify-fail to conv to verify fixture stays bounded", async () => {
  const root = await tempRoot("pilot-conv-");
  const stateRoot = await tempRoot("pilot-state-");
  const missingArtifact = join(root, "evidence-update.md");
  const packet: EvidencePacket = {
    schema_version: "pilot.evidence.v0",
    claim: {
      id: "conv-created-evidence",
      statement: "A local convergence update exists as evidence.",
      profile: "document_strategy",
    },
    verdict_criteria: [
      {
        id: "update-present",
        description: "The evidence update artifact exists.",
        required: true,
      },
    ],
    evidence: [
      {
        id: "update",
        type: "artifact",
        description: "Evidence update artifact.",
        criteria_ids: ["update-present"],
        supports_claim: true,
        in_scope: true,
        path: missingArtifact,
      },
    ],
    reviewer_boundary: {
      semantic_review_required: true,
      deterministic_checks_only: true,
    },
  };
  const packetPath = join(root, "packet.json");
  await writeJson(packetPath, packet);
  const firstVerify = await runVerify({
    packetPath,
    stateRoot,
    now: new Date("2026-06-01T00:00:00.000Z"),
  });
  assert.equal(firstVerify.verdict, "missing_evidence");

  const convRequest = baseConvRequest();
  convRequest.anchor.path = packetPath;
  const convPath = join(root, "conv.json");
  await writeJson(convPath, convRequest);
  const convResult = await runConv({
    requestPath: convPath,
    stateRoot,
    now: new Date("2026-06-01T00:00:01.000Z"),
  });
  assert.equal(convResult.status, "completed");

  packet.evidence[0].path = convResult.rounds[0].evidence_update;
  packet.specialized_reviewers = [
    {
      id: "reviewer-convergence",
      role: "Convergence verifier",
      specialty: "Fix confirmation",
      verdict: "pass",
      confidence: "high",
      notes: ["The convergence round produced the missing evidence update."],
    },
    {
      id: "reviewer-engineering",
      role: "Engineering verifier",
      specialty: "Local artifact and evidence mapping",
      verdict: "pass",
      confidence: "high",
      notes: ["The updated evidence path points to the local convergence artifact."],
    },
  ];
  await writeJson(packetPath, packet);
  const secondVerify = await runVerify({
    packetPath,
    stateRoot,
    now: new Date("2026-06-01T00:00:02.000Z"),
  });
  assert.equal(secondVerify.verdict, "sufficient_evidence");
});
