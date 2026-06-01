import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { runVerify } from "../src/verify/run.ts";
import type { EvidencePacket } from "../src/types.ts";

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

async function writePacket(root: string, packet: EvidencePacket): Promise<string> {
  const packetPath = join(root, "packet.json");
  await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  return packetPath;
}

function basePacket(evidencePath: string): EvidencePacket {
  return {
    schema_version: "pilot.evidence.v0",
    claim: {
      id: "document-strategy-phase1",
      statement: "Phase 1 artifacts satisfy the document strategy fixture.",
      profile: "document_strategy",
    },
    verdict_criteria: [
      {
        id: "artifact-present",
        description: "The expected document strategy artifact exists.",
        required: true,
      },
    ],
    evidence: [
      {
        id: "plan-md",
        type: "artifact",
        description: "Plan artifact produced by the run.",
        criteria_ids: ["artifact-present"],
        supports_claim: true,
        in_scope: true,
        path: evidencePath,
      },
    ],
    reviewer_boundary: {
      semantic_review_required: true,
      deterministic_checks_only: true,
    },
    specialized_reviewers: [
      {
        id: "reviewer-product",
        role: "Product verifier",
        specialty: "Goal fit and user expectation",
        verdict: "pass",
        confidence: "high",
        notes: ["The evidence is structurally present for this fixture."],
      },
      {
        id: "reviewer-engineering",
        role: "Engineering verifier",
        specialty: "Artifact and regression risk",
        verdict: "pass",
        confidence: "high",
        notes: ["The required artifact exists and maps to the required criterion."],
      },
    ],
  };
}

test("pilot verify returns sufficient_evidence for a well-formed document fixture", async () => {
  const root = await tempRoot("pilot-verify-");
  const stateRoot = await tempRoot("pilot-state-");
  const artifactPath = join(root, "plan.md");
  await writeFile(artifactPath, "# Plan\n", "utf8");
  const packetPath = await writePacket(root, basePacket(artifactPath));

  const result = await runVerify({
    packetPath,
    stateRoot,
    now: new Date("2026-06-01T00:00:00.000Z"),
  });

  assert.equal(result.verdict, "sufficient_evidence");
  assert.equal(result.semantic_verdict, "pass");
  assert.equal(result.reviewer_summary.status, "completed");
  assert.equal(result.created_files.length, 4);
  assert.equal(await fileExists(join(result.artifact_dir, "verification.json")), true);
  assert.equal(await fileExists(join(result.artifact_dir, "events.jsonl")), true);
  assert.equal(await fileExists(join(result.artifact_dir, "final.md")), true);
  assert.equal(await fileExists(join(result.artifact_dir, "lineage.jsonl")), true);
  assert.equal(await fileExists(join(stateRoot, "index", "lineage.jsonl")), true);

  const verification = JSON.parse(await readFile(join(result.artifact_dir, "verification.json"), "utf8"));
  assert.equal(verification.verdict, "sufficient_evidence");
  assert.ok(verification.created_files.some((path: string) => path.endsWith("lineage.jsonl")));
  const lineage = await readFile(join(result.artifact_dir, "lineage.jsonl"), "utf8");
  assert.ok(lineage.includes('"command":"/verify"'));
  assert.match(await readFile(join(result.artifact_dir, "events.jsonl"), "utf8"), /"semantic_judgment":"pass"/);
});

test("pilot verify blocks full semantic verdict without two specialized reviewers", async () => {
  const root = await tempRoot("pilot-verify-");
  const stateRoot = await tempRoot("pilot-state-");
  const artifactPath = join(root, "plan.md");
  await writeFile(artifactPath, "# Plan\n", "utf8");
  const packet = basePacket(artifactPath);
  packet.specialized_reviewers = packet.specialized_reviewers?.slice(0, 1);
  const packetPath = await writePacket(root, packet);

  const result = await runVerify({
    packetPath,
    stateRoot,
    now: new Date("2026-06-01T00:00:00.000Z"),
  });

  assert.equal(result.verdict, "blocked");
  assert.equal(result.semantic_verdict, "incomplete");
  assert.equal(result.reviewer_summary.status, "missing_reviewers");
  assert.ok(result.findings.some((finding) => finding.code === "semantic_reviewers_missing"));
});

test("pilot verify reports missing_evidence when required artifact is absent", async () => {
  const root = await tempRoot("pilot-verify-");
  const stateRoot = await tempRoot("pilot-state-");
  const packetPath = await writePacket(root, basePacket(join(root, "missing.md")));

  const result = await runVerify({
    packetPath,
    stateRoot,
    now: new Date("2026-06-01T00:00:00.000Z"),
  });

  assert.equal(result.verdict, "missing_evidence");
  assert.ok(result.findings.some((finding) => finding.code === "artifact_missing"));
});

test("pilot verify rejects out-of-scope evidence with needs_revision", async () => {
  const root = await tempRoot("pilot-verify-");
  const stateRoot = await tempRoot("pilot-state-");
  const artifactPath = join(root, "plan.md");
  await writeFile(artifactPath, "# Plan\n", "utf8");
  const packet = basePacket(artifactPath);
  packet.evidence[0].in_scope = false;
  const packetPath = await writePacket(root, packet);

  const result = await runVerify({
    packetPath,
    stateRoot,
    now: new Date("2026-06-01T00:00:00.000Z"),
  });

  assert.equal(result.verdict, "needs_revision");
  assert.ok(result.findings.some((finding) => finding.code === "evidence_out_of_scope"));
});

test("pilot verify handles malformed packets as blocked", async () => {
  const root = await tempRoot("pilot-verify-");
  const stateRoot = await tempRoot("pilot-state-");
  const packet = basePacket(join(root, "plan.md"));
  packet.verdict_criteria = [];
  const packetPath = await writePacket(root, packet);

  const result = await runVerify({
    packetPath,
    stateRoot,
    now: new Date("2026-06-01T00:00:00.000Z"),
  });

  assert.equal(result.verdict, "blocked");
  assert.ok(result.findings.some((finding) => finding.code === "schema_invalid"));
});

test("pilot verify requires event references for event evidence", async () => {
  const root = await tempRoot("pilot-verify-");
  const stateRoot = await tempRoot("pilot-state-");
  const packet = basePacket(join(root, "plan.md"));
  packet.evidence = [
    {
      id: "event-without-ref",
      type: "event",
      description: "Malformed event evidence.",
      criteria_ids: ["artifact-present"],
      supports_claim: true,
      in_scope: true,
    },
  ];
  const packetPath = await writePacket(root, packet);

  const result = await runVerify({
    packetPath,
    stateRoot,
    now: new Date("2026-06-01T00:00:00.000Z"),
  });

  assert.equal(result.verdict, "blocked");
  assert.ok(result.findings.some((finding) => finding.message.includes("missing event reference")));
});

test("pilot verify does not infer semantic sufficiency from text", async () => {
  const root = await tempRoot("pilot-verify-");
  const stateRoot = await tempRoot("pilot-state-");
  const artifactPath = join(root, "plan.md");
  await writeFile(artifactPath, "PASS perfect sufficient complete", "utf8");
  const packet = basePacket(artifactPath);
  packet.evidence[0].supports_claim = false;
  const packetPath = await writePacket(root, packet);

  const result = await runVerify({
    packetPath,
    stateRoot,
    now: new Date("2026-06-01T00:00:00.000Z"),
  });

  assert.equal(result.verdict, "insufficient_evidence");
});

test("Phase 2 CLI verify smoke evaluates a packet", async () => {
  const root = await tempRoot("pilot-verify-");
  const stateRoot = await tempRoot("pilot-state-");
  const artifactPath = join(root, "plan.md");
  await writeFile(artifactPath, "# Plan\n", "utf8");
  const packetPath = await writePacket(root, basePacket(artifactPath));

  const result = spawnSync(process.execPath, ["src/cli.ts", "artifact", "verify", packetPath], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PILOT_STATE_ROOT: stateRoot },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.verdict, "sufficient_evidence");
  assert.equal(output.semantic_verdict, "pass");
  assert.equal(await fileExists(join(output.artifact_dir, "verification.json")), true);
});

test("document_strategy fixture can be verified from the repository", () => {
  const result = spawnSync(process.execPath, ["src/cli.ts", "artifact", "verify", "fixtures/document_strategy/evidence-packet.json"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.verdict, "sufficient_evidence");
  assert.equal(output.semantic_verdict, "pass");
});

test("goal command requires a natural objective or approved run reference", () => {
  const result = spawnSync(process.execPath, ["src/cli.ts", "goal"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires a natural-language objective or approved run reference/);
});
