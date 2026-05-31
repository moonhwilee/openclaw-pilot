import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  CONFIG_FILENAME,
  defaultConfig,
  expandHome,
  projectConfigPath,
  type PilotConfig,
} from "../config.ts";

export type InitResult = {
  schema_version: "pilot.init.v0";
  status: "initialized" | "already_initialized";
  config_path: string;
  state_root: string;
  created_files: string[];
  next_steps: string[];
};

export async function runInit(options: { cwd?: string; force?: boolean } = {}): Promise<InitResult> {
  const cwd = options.cwd || process.cwd();
  const configPath = projectConfigPath(cwd);
  const config: PilotConfig = defaultConfig();
  const stateRoot = expandHome(config.state_root);
  const createdFiles: string[] = [];

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
