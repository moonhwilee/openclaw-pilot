import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig, expandHome, loadProjectConfig, projectConfigPath } from "../config.js";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
async function exists(path) {
    try {
        await stat(path);
        return true;
    }
    catch {
        return false;
    }
}
function summarize(checks, strict) {
    if (checks.some((check) => check.status === "error"))
        return "error";
    if (checks.some((check) => check.status === "warning"))
        return strict ? "error" : "warning";
    return "ok";
}
export async function runDoctor(options = {}) {
    const cwd = options.cwd || process.cwd();
    const strict = Boolean(options.strict);
    const checks = [];
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    checks.push({
        name: "node_version",
        status: nodeMajor >= 22 ? "ok" : "error",
        message: `Node ${process.versions.node}; OpenClaw Pilot expects Node 22.18 or newer.`,
    });
    const packagePath = resolve(packageRoot, "package.json");
    checks.push({
        name: "package",
        status: (await exists(packagePath)) ? "ok" : "error",
        message: (await exists(packagePath)) ? "Package metadata found." : "Package metadata is missing.",
    });
    const configPath = projectConfigPath(cwd);
    const config = loadProjectConfig(cwd);
    checks.push({
        name: "config",
        status: config ? "ok" : "warning",
        message: config ? `Config found at ${configPath}.` : `No ${CONFIG_HINT}; run pilot init to create one.`,
    });
    const stateRoot = expandHome(config?.state_root || defaultConfig().state_root);
    try {
        await access(stateRoot, constants.W_OK);
        checks.push({ name: "state_root", status: "ok", message: `State root is writable: ${stateRoot}` });
    }
    catch {
        checks.push({
            name: "state_root",
            status: config ? "error" : "warning",
            message: `State root is not writable yet: ${stateRoot}. Run pilot init.`,
        });
    }
    for (const fixture of [
        "fixtures/document_strategy/evidence-packet.json",
        "fixtures/document_strategy/conv-request.json",
        "fixtures/document_strategy/goal-request-draft.json",
        "fixtures/document_strategy/goal-request-approved.json",
    ]) {
        const fixturePath = resolve(packageRoot, fixture);
        checks.push({
            name: `fixture:${fixture}`,
            status: (await exists(fixturePath)) ? "ok" : "error",
            message: (await exists(fixturePath)) ? "Fixture available." : `Fixture missing: ${fixture}`,
        });
    }
    const status = summarize(checks, strict);
    return {
        schema_version: "pilot.doctor.v0",
        status,
        strict,
        checks,
        next_steps: status === "ok"
            ? ['Run `pilot plan "Draft a local document strategy plan"` to start.']
            : ["Run `pilot init` first, then rerun `pilot doctor`.", "Use `pilot smoke` for a quick health check."],
    };
}
const CONFIG_HINT = "pilot.config.json";
