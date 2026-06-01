import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { PilotLineageRecord } from "../types.ts";

export const LINEAGE_INDEX_RELATIVE_PATH = "index/lineage.jsonl";
export const LINEAGE_RUN_RELATIVE_PATH = "lineage.jsonl";

export type LineageWriteResult = {
  index_path: string;
  run_path: string;
};

export async function appendLineageRecord(stateRoot: string, record: PilotLineageRecord): Promise<LineageWriteResult> {
  const indexDir = join(stateRoot, "index");
  const indexPath = join(stateRoot, LINEAGE_INDEX_RELATIVE_PATH);
  const runPath = join(record.artifact_dir, LINEAGE_RUN_RELATIVE_PATH);
  const line = `${JSON.stringify(record)}\n`;

  await mkdir(indexDir, { recursive: true });
  await appendFile(indexPath, line, "utf8");
  await appendFile(runPath, line, "utf8");

  return {
    index_path: indexPath,
    run_path: runPath,
  };
}
