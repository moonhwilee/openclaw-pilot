import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
export const DEFAULT_PROFILE = "document_strategy";
export const DEFAULT_ENABLED_COMMANDS = ["/plan", "/verify", "/conv", "/goal"];
export const DEFAULT_ARTIFACT_RETENTION_DAYS = 14;
export const CONFIG_FILENAME = "pilot.config.json";
export function expandHome(path) {
    if (path === "~")
        return homedir();
    if (path.startsWith("~/"))
        return resolve(homedir(), path.slice(2));
    return path;
}
export function defaultConfig() {
    return {
        schema_version: "pilot.config.v0",
        state_root: resolve(homedir(), ".openclaw/state/pilot"),
        default_profile: DEFAULT_PROFILE,
        enabled_commands: [...DEFAULT_ENABLED_COMMANDS],
        artifact_retention_days: DEFAULT_ARTIFACT_RETENTION_DAYS,
        live_routing_enabled: false,
    };
}
export function projectConfigPath(cwd = process.cwd()) {
    return resolve(cwd, CONFIG_FILENAME);
}
export function loadProjectConfig(cwd = process.cwd()) {
    const path = projectConfigPath(cwd);
    if (!existsSync(path))
        return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return {
        ...defaultConfig(),
        ...parsed,
        schema_version: "pilot.config.v0",
    };
}
export function defaultStateRoot() {
    const envStateRoot = process.env.PILOT_STATE_ROOT?.trim();
    if (envStateRoot)
        return resolve(expandHome(envStateRoot));
    const config = loadProjectConfig();
    if (config?.state_root?.trim())
        return resolve(expandHome(config.state_root));
    return defaultConfig().state_root;
}
