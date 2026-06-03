import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const fixtureRoot = join(process.cwd(), "fixtures", "workbench", "team-leader-controlled");

type JsonObject = Record<string, unknown>;

async function readFixture(name: string): Promise<JsonObject> {
  return JSON.parse(await readFile(join(fixtureRoot, name), "utf8")) as JsonObject;
}

function stringField(value: JsonObject, key: string): string {
  const field = value[key];
  assert.equal(typeof field, "string", `${key} must be a string`);
  assert.notEqual((field as string).trim(), "", `${key} must not be empty`);
  return field as string;
}

function stringArrayField(value: JsonObject, key: string): string[] {
  const field = value[key];
  assert.equal(Array.isArray(field), true, `${key} must be an array`);
  for (const item of field as unknown[]) {
    assert.equal(typeof item, "string", `${key} entries must be strings`);
    assert.notEqual((item as string).trim(), "", `${key} entries must not be empty`);
  }
  return field as string[];
}

function validatePositivePilotArtifact(artifact: JsonObject): string[] {
  const errors: string[] = [];

  if (artifact.schema_version !== "pilot.workbench_artifact.v0") errors.push("invalid schema_version");
  if (artifact.pilot_role !== "control_evidence_recovery_feature") errors.push("Pilot must be a feature, not an actor");
  if (artifact.pilot_control_mode !== "team-leader-controlled") errors.push("invalid pilot_control_mode");
  if (artifact.subagent_orchestration_mode !== "direct-main-session") errors.push("invalid subagent_orchestration_mode");
  if ("hidden_orchestrator_actor_ref" in artifact) errors.push("hidden orchestrator actor ref is forbidden");

  const forbiddenActorRefs = Array.isArray(artifact.forbidden_actor_refs) ? artifact.forbidden_actor_refs : [];
  if (forbiddenActorRefs.length > 0) errors.push("positive artifact must not contain forbidden actor refs");

  const directSubagentTaskRefs = Array.isArray(artifact.direct_subagent_task_refs) ? artifact.direct_subagent_task_refs : [];
  if (directSubagentTaskRefs.length === 0) errors.push("direct subagent task refs are required");

  return errors;
}

test("Workbench fixture records team-leader-controlled Pilot contract", async () => {
  const workUnit = await readFixture("work-unit.json");
  const contextPacket = await readFixture("internal-context-packet.json");
  const pilotArtifact = await readFixture("expected-pilot-artifact.json");

  assert.equal(workUnit.schema_version, "openclaw.work_unit.v0");
  assert.equal(contextPacket.schema_version, "openclaw.internal_context_packet.v0");
  assert.equal(pilotArtifact.schema_version, "pilot.workbench_artifact.v0");

  const workUnitId = stringField(workUnit, "work_unit_id");
  const ownerMainSessionRef = stringField(workUnit, "owner_main_session_ref");
  const contextPacketRef = stringField(workUnit, "context_packet_ref");
  const localRegistryRef = stringField(workUnit, "local_registry_ref");
  const subagentTaskRefs = stringArrayField(workUnit, "subagent_task_refs");

  assert.equal(workUnit.pilot_control_mode, "team-leader-controlled");
  assert.equal(workUnit.subagent_orchestration_mode, "direct-main-session");
  assert.equal(contextPacket.work_unit_id, workUnitId);
  assert.equal(contextPacket.owner_main_session_ref, ownerMainSessionRef);
  assert.equal(pilotArtifact.work_unit_ref, workUnitId);
  assert.equal(pilotArtifact.owner_main_session_ref, ownerMainSessionRef);
  assert.equal(pilotArtifact.context_packet_ref, contextPacketRef);
  assert.equal(pilotArtifact.local_registry_ref, localRegistryRef);
  assert.deepEqual(pilotArtifact.direct_subagent_task_refs, subagentTaskRefs);
  assert.deepEqual(validatePositivePilotArtifact(pilotArtifact), []);
});

test("Workbench negative fixture rejects hidden orchestrator Pilot semantics", async () => {
  const negativeArtifact = await readFixture("negative-hidden-orchestrator.json");

  const errors = validatePositivePilotArtifact(negativeArtifact);
  assert.ok(errors.includes("Pilot must be a feature, not an actor"));
  assert.ok(errors.includes("invalid pilot_control_mode"));
  assert.ok(errors.includes("invalid subagent_orchestration_mode"));
  assert.ok(errors.includes("hidden orchestrator actor ref is forbidden"));
});
