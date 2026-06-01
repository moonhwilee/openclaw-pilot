import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PilotRunIndexEntry } from "../types.ts";

export const RUN_INDEX_RELATIVE_PATH = "index/runs.jsonl";

export type RunIndexResolution =
  | { status: "found"; entry: PilotRunIndexEntry }
  | { status: "not_found"; reference: string }
  | { status: "ambiguous"; reference: string; matches: PilotRunIndexEntry[] };

export function shortRunId(runId: string): string {
  const stamp = runId.match(/^(\d{8}T\d{6}Z)/)?.[1];
  if (stamp) return stamp.slice(9, 15);
  return runId.slice(0, 12);
}

export async function appendRunIndexEntry(stateRoot: string, entry: PilotRunIndexEntry): Promise<string> {
  const indexDir = join(stateRoot, "index");
  const indexPath = join(stateRoot, RUN_INDEX_RELATIVE_PATH);
  await mkdir(indexDir, { recursive: true });
  await appendFile(indexPath, `${JSON.stringify(entry)}\n`, "utf8");
  return indexPath;
}

function cleanReference(reference: string): string {
  return reference.trim().replace(/^["'`]+|["'`.,]+$/g, "");
}

function isRunIndexEntry(value: unknown): value is PilotRunIndexEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<PilotRunIndexEntry>;
  return (
    entry.schema_version === "pilot.run_index.v0" &&
    typeof entry.run_id === "string" &&
    typeof entry.short_run_id === "string" &&
    typeof entry.artifact_dir === "string"
  );
}

export async function readRunIndexEntries(stateRoot: string): Promise<PilotRunIndexEntry[]> {
  const indexPath = join(stateRoot, RUN_INDEX_RELATIVE_PATH);
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
    .filter(isRunIndexEntry);
}

export async function resolveRunIndexEntry(stateRoot: string, reference: string): Promise<RunIndexResolution> {
  const cleaned = cleanReference(reference);
  if (!cleaned) return { status: "not_found", reference: cleaned };

  const entries = await readRunIndexEntries(stateRoot);
  const exactMatches = entries.filter((entry) => entry.run_id === cleaned);
  if (exactMatches.length > 0) return { status: "found", entry: exactMatches[exactMatches.length - 1] };

  const shortMatches = entries.filter((entry) => entry.short_run_id === cleaned);
  if (shortMatches.length === 0) return { status: "not_found", reference: cleaned };
  if (shortMatches.length === 1) return { status: "found", entry: shortMatches[0] };
  return { status: "ambiguous", reference: cleaned, matches: shortMatches };
}
