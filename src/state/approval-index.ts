import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PilotApprovalEntry } from "../types.ts";

export const APPROVAL_INDEX_RELATIVE_PATH = "index/approvals.jsonl";

export type ApprovalIndexResolution =
  | { status: "found"; entry: PilotApprovalEntry }
  | { status: "not_found"; reference: string }
  | { status: "ambiguous"; reference: string; matches: PilotApprovalEntry[] };

export async function appendApprovalEntry(stateRoot: string, entry: PilotApprovalEntry): Promise<string> {
  const indexDir = join(stateRoot, "index");
  const indexPath = join(stateRoot, APPROVAL_INDEX_RELATIVE_PATH);
  await mkdir(indexDir, { recursive: true });
  await appendFile(indexPath, `${JSON.stringify(entry)}\n`, "utf8");
  return indexPath;
}

function cleanReference(reference: string): string {
  return reference.trim().replace(/^["'`]+|["'`.,]+$/g, "");
}

function isApprovalEntry(value: unknown): value is PilotApprovalEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<PilotApprovalEntry>;
  return (
    entry.schema_version === "pilot.approval.v0" &&
    entry.status === "approved" &&
    typeof entry.run_id === "string" &&
    typeof entry.short_run_id === "string" &&
    typeof entry.artifact_dir === "string"
  );
}

export async function readApprovalEntries(stateRoot: string): Promise<PilotApprovalEntry[]> {
  const indexPath = join(stateRoot, APPROVAL_INDEX_RELATIVE_PATH);
  let text: string;
  try {
    text = await readFile(indexPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isApprovalEntry);
}

export async function resolveApprovalEntry(stateRoot: string, reference: string): Promise<ApprovalIndexResolution> {
  const cleaned = cleanReference(reference);
  if (!cleaned) return { status: "not_found", reference: cleaned };

  const entries = await readApprovalEntries(stateRoot);
  const exactMatches = entries.filter((entry) => entry.run_id === cleaned);
  if (exactMatches.length > 0) return { status: "found", entry: exactMatches[exactMatches.length - 1] };

  const shortMatches = entries.filter((entry) => entry.short_run_id === cleaned);
  if (shortMatches.length === 0) return { status: "not_found", reference: cleaned };
  if (shortMatches.length === 1) return { status: "found", entry: shortMatches[0] };
  return { status: "ambiguous", reference: cleaned, matches: shortMatches };
}
