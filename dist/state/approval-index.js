import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
export const APPROVAL_INDEX_RELATIVE_PATH = "index/approvals.jsonl";
export async function appendApprovalEntry(stateRoot, entry) {
    const indexDir = join(stateRoot, "index");
    const indexPath = join(stateRoot, APPROVAL_INDEX_RELATIVE_PATH);
    await mkdir(indexDir, { recursive: true });
    await appendFile(indexPath, `${JSON.stringify(entry)}\n`, "utf8");
    return indexPath;
}
function cleanReference(reference) {
    return reference.trim().replace(/^["'`]+|["'`.,]+$/g, "");
}
function isApprovalEntry(value) {
    if (!value || typeof value !== "object")
        return false;
    const entry = value;
    return (entry.schema_version === "pilot.approval.v0" &&
        entry.status === "approved" &&
        typeof entry.run_id === "string" &&
        typeof entry.short_run_id === "string" &&
        typeof entry.artifact_dir === "string");
}
export async function readApprovalEntries(stateRoot) {
    const indexPath = join(stateRoot, APPROVAL_INDEX_RELATIVE_PATH);
    let text;
    try {
        text = await readFile(indexPath, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return [];
        throw error;
    }
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter(isApprovalEntry);
}
export async function resolveApprovalEntry(stateRoot, reference) {
    const cleaned = cleanReference(reference);
    if (!cleaned)
        return { status: "not_found", reference: cleaned };
    const entries = await readApprovalEntries(stateRoot);
    const exactMatches = entries.filter((entry) => entry.run_id === cleaned);
    if (exactMatches.length > 0)
        return { status: "found", entry: exactMatches[exactMatches.length - 1] };
    const shortMatches = entries.filter((entry) => entry.short_run_id === cleaned);
    if (shortMatches.length === 0)
        return { status: "not_found", reference: cleaned };
    if (shortMatches.length === 1)
        return { status: "found", entry: shortMatches[0] };
    return { status: "ambiguous", reference: cleaned, matches: shortMatches };
}
