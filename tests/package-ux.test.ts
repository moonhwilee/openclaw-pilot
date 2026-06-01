import { mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { runInit } from "../src/init/run.ts";
import { runDoctor } from "../src/doctor/run.ts";
import { runSmoke } from "../src/smoke/run.ts";

async function tempCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pilot-package-ux-"));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test("pilot init creates a minimal config and state root", async () => {
  const cwd = await tempCwd();
  const result = await runInit({ cwd });

  assert.equal(result.status, "initialized");
  assert.equal(await fileExists(join(cwd, "pilot.config.json")), true);
  assert.match(result.state_root, /\.openclaw\/state\/pilot$/);

  const config = JSON.parse(await readFile(join(cwd, "pilot.config.json"), "utf8"));
  assert.equal(config.schema_version, "pilot.config.v0");
  assert.equal(config.default_profile, "document_strategy");
  assert.equal(config.live_routing_enabled, false);
});

test("pilot init is idempotent unless forced", async () => {
  const cwd = await tempCwd();
  await runInit({ cwd });
  const result = await runInit({ cwd });

  assert.equal(result.status, "already_initialized");
  assert.deepEqual(result.created_files, []);
});

test("doctor is friendly by default and strict when requested", async () => {
  const cwd = await tempCwd();
  const defaultResult = await runDoctor({ cwd });
  assert.equal(defaultResult.status, "warning");
  assert.ok(defaultResult.checks.some((check) => check.name === "config" && check.status === "warning"));

  const strictResult = await runDoctor({ cwd, strict: true });
  assert.equal(strictResult.status, "error");

  await runInit({ cwd });
  const initializedResult = await runDoctor({ cwd });
  assert.equal(initializedResult.status, "ok");
});

test("smoke checks package defaults", async () => {
  const result = await runSmoke();

  assert.equal(result.status, "ok");
  assert.ok(result.checks.some((check) => check.name === "plan" && check.status === "ok"));
  assert.ok(result.checks.some((check) => check.name === "execution_plan_contract" && check.status === "ok"));
  assert.ok(result.checks.some((check) => check.name === "live_adapter" && check.status === "ok"));
});

test("package UX CLI exposes init doctor and smoke", async () => {
  const cwd = await tempCwd();
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const init = spawnSync(process.execPath, [cliPath, "init"], {
    cwd,
    encoding: "utf8",
  });

  assert.equal(init.status, 0, init.stderr);
  const initOutput = JSON.parse(init.stdout);
  assert.equal(initOutput.schema_version, "pilot.init.v0");

  const doctor = spawnSync(process.execPath, [cliPath, "doctor"], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(doctor.status, 0, doctor.stderr);

  const smoke = spawnSync(process.execPath, [cliPath, "smoke"], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(smoke.status, 0, smoke.stderr);
});
