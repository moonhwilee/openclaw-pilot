import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { defaultConfig, expandHome, projectConfigPath, } from "../config.js";
export async function runInit(options = {}) {
    const cwd = options.cwd || process.cwd();
    const configPath = projectConfigPath(cwd);
    const config = defaultConfig();
    const stateRoot = expandHome(config.state_root);
    const createdFiles = [];
    await mkdir(stateRoot, { recursive: true });
    await mkdir(`${stateRoot}/runs`, { recursive: true });
    if (!existsSync(configPath) || options.force) {
        await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
        createdFiles.push(configPath);
    }
    return {
        schema_version: "pilot.init.v0",
        status: createdFiles.length > 0 ? "initialized" : "already_initialized",
        config_path: configPath,
        state_root: stateRoot,
        created_files: createdFiles,
        next_steps: [
            'Run `pilot plan "Draft a local document strategy plan"`.',
            "Run `pilot doctor` if anything looks off.",
            "Run `pilot smoke` for a quick package health check.",
        ],
    };
}
