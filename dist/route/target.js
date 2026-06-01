import { stat } from "node:fs/promises";
import { listRecoveryRuns } from "../state/recovery.js";
const recentAliases = new Set(["recent", "latest", "last", "최근", "마지막", "방금", "최신"]);
function firstToken(value) {
    return value.trim().split(/\s+/)[0] || "";
}
export function looksLikeRunReference(value) {
    return /^\d{6}$/.test(value) || /^\d{8}T\d{6}Z-[a-z0-9가-힣-]+$/.test(value);
}
export function looksLikeJsonPath(value) {
    const trimmed = value.trim();
    return /^[^\s]+\.json$/i.test(trimmed);
}
async function pathExists(path) {
    try {
        const info = await stat(path);
        return info.isFile();
    }
    catch {
        return false;
    }
}
export async function resolveArtifactCommandTarget(raw) {
    const rest = raw.trim();
    return (await pathExists(rest))
        ? { kind: "json_path_existing", raw: rest, path: rest }
        : { kind: "json_path_missing", raw: rest, path: rest };
}
export async function resolveUserCommandTarget(raw) {
    const rest = raw.trim();
    if (!rest)
        return { kind: "empty", raw: rest };
    if (looksLikeJsonPath(rest))
        return { kind: "artifact_like_disabled", raw: rest, path: rest };
    const token = firstToken(rest);
    if (looksLikeRunReference(token))
        return { kind: "run_reference", raw: rest, reference: token };
    if (recentAliases.has(token.toLowerCase()))
        return { kind: "recent_alias", raw: rest, alias: token };
    return { kind: "natural_language", raw: rest, text: rest };
}
export async function latestRecoveryRun(stateRoot) {
    return (await listRecoveryRuns(stateRoot, 1))[0];
}
