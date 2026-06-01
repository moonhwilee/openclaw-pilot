import { spawn } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GoalRequest } from "../types.ts";

export const goalCapabilityNames = [
  "create_artifact",
  "create_pilot_receipts_dashboard",
  "create_review_note",
  "run_codex_session",
] as const;

export type GoalCapabilityName = (typeof goalCapabilityNames)[number];

export type GoalCapabilityContext = {
  request: GoalRequest;
  stateRoot: string;
  artifactDir: string;
  runId: string;
  createdAt: string;
};

export type GoalCapabilityExecution = {
  capability: GoalCapabilityName;
  action: string;
  action_summary: string;
  artifact_path: string;
  supporting_artifacts?: string[];
  event_details?: Record<string, unknown>;
  evidence_message: string;
};

export type GoalCapabilityRunner = (context: GoalCapabilityContext) => Promise<GoalCapabilityExecution>;

type ReceiptRow = {
  run_id: string;
  action: string;
  capability: string;
  status: string;
  actor?: string;
  timestamp?: string;
  artifact_path?: string;
  approval_reference?: string;
  primary_proof?: boolean;
};

class GoalCapabilityError extends Error {
  artifact_path?: string;
  supporting_artifacts?: string[];

  constructor(message: string, options?: { artifact_path?: string; supporting_artifacts?: string[] }) {
    super(message);
    this.name = "GoalCapabilityError";
    this.artifact_path = options?.artifact_path;
    this.supporting_artifacts = options?.supporting_artifacts;
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function readReceiptRows(stateRoot: string): Promise<ReceiptRow[]> {
  const runsDir = join(stateRoot, "runs");
  let runDirents;
  try {
    runDirents = await readdir(runsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const rows: ReceiptRow[] = [];
  for (const dirent of runDirents) {
    if (!dirent.isDirectory()) continue;
    const runId = dirent.name;
    const receiptPath = join(runsDir, runId, "receipts.jsonl");
    let text: string;
    try {
      text = await readFile(receiptPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }

    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as Partial<ReceiptRow>;
        rows.push({
          run_id: String(parsed.run_id || runId),
          action: String(parsed.action || "unknown"),
          capability: String(parsed.capability || "unknown"),
          status: String(parsed.status || "unknown"),
          actor: parsed.actor ? String(parsed.actor) : undefined,
          timestamp: parsed.timestamp ? String(parsed.timestamp) : undefined,
          artifact_path: parsed.artifact_path ? String(parsed.artifact_path) : undefined,
          approval_reference: parsed.approval_reference ? String(parsed.approval_reference) : undefined,
          primary_proof: Boolean(parsed.primary_proof),
        });
      } catch {
        rows.push({
          run_id: runId,
          action: "unreadable_receipt_line",
          capability: "parse_receipt",
          status: "unknown",
          artifact_path: receiptPath,
        });
      }
    }
  }

  return rows.sort((left, right) => String(right.timestamp || "").localeCompare(String(left.timestamp || ""))).slice(0, 200);
}

function renderPilotReceiptsDashboard(request: GoalRequest, rows: ReceiptRow[], createdAt: string): string {
  const capabilityCounts = new Map<string, number>();
  for (const row of rows) {
    capabilityCounts.set(row.capability, (capabilityCounts.get(row.capability) || 0) + 1);
  }
  const topCapabilities = [...capabilityCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6);
  const latestRows = rows.slice(0, 50);
  const dataJson = JSON.stringify({ createdAt, request: request.goal.statement, rows, topCapabilities });

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pilot Receipts Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #172033;
      --muted: #647084;
      --line: #d8dde8;
      --panel: #ffffff;
      --surface: #f6f7fb;
      --green: #0f7b66;
      --blue: #315f9d;
      --amber: #a96518;
      --rose: #a13e4a;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: var(--surface);
    }
    header {
      padding: 24px 28px 18px;
      border-bottom: 1px solid var(--line);
      background: #ffffff;
    }
    h1, h2 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 24px; }
    h2 { font-size: 15px; }
    .subtitle { margin-top: 6px; color: var(--muted); max-width: 980px; }
    main { padding: 20px 28px 28px; }
    .metrics {
      display: grid;
      grid-template-columns: repeat(4, minmax(150px, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .metric, section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .metric { padding: 14px 16px; min-height: 82px; }
    .metric strong { display: block; font-size: 26px; margin-top: 6px; }
    .metric span { color: var(--muted); font-size: 12px; text-transform: uppercase; }
    .metric:nth-child(1) strong { color: var(--green); }
    .metric:nth-child(2) strong { color: var(--blue); }
    .metric:nth-child(3) strong { color: var(--amber); }
    .metric:nth-child(4) strong { color: var(--rose); }
    .grid {
      display: grid;
      grid-template-columns: minmax(260px, 0.85fr) minmax(420px, 1.6fr);
      gap: 14px;
      align-items: start;
    }
    section { overflow: hidden; }
    section h2 {
      padding: 13px 16px;
      border-bottom: 1px solid var(--line);
      background: #fbfcff;
    }
    .cap-list { list-style: none; margin: 0; padding: 8px 0; }
    .cap-list li {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 16px;
      border-bottom: 1px solid #edf0f6;
    }
    .cap-list li:last-child { border-bottom: 0; }
    .cap-name { overflow-wrap: anywhere; }
    .count { color: var(--muted); font-variant-numeric: tabular-nums; }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid #edf0f6;
      text-align: left;
      vertical-align: top;
      overflow-wrap: anywhere;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
      background: #fbfcff;
    }
    tbody tr:hover { background: #f9fbff; }
    .status {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 999px;
      background: #eaf6f2;
      color: #0f6757;
      font-size: 12px;
    }
    .path { color: var(--muted); font-size: 12px; }
    @media (max-width: 860px) {
      header, main { padding-left: 16px; padding-right: 16px; }
      .metrics, .grid { grid-template-columns: 1fr; }
      table { min-width: 760px; }
      .table-wrap { overflow-x: auto; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Pilot Receipts Dashboard</h1>
    <div class="subtitle">${escapeHtml(request.goal.statement)}</div>
  </header>
  <main>
    <div class="metrics">
      <div class="metric"><span>Total receipts</span><strong>${rows.length}</strong></div>
      <div class="metric"><span>Capabilities</span><strong>${capabilityCounts.size}</strong></div>
      <div class="metric"><span>Primary proofs</span><strong>${rows.filter((row) => row.primary_proof).length}</strong></div>
      <div class="metric"><span>Generated</span><strong>${escapeHtml(createdAt.slice(11, 16))}</strong></div>
    </div>
    <div class="grid">
      <section>
        <h2>Capability Mix</h2>
        <ul class="cap-list">
          ${topCapabilities.length
            ? topCapabilities.map(([capability, count]) => `<li><span class="cap-name">${escapeHtml(capability)}</span><span class="count">${count}</span></li>`).join("\n          ")
            : "<li><span class=\"cap-name\">No receipts found</span><span class=\"count\">0</span></li>"}
        </ul>
      </section>
      <section>
        <h2>Latest Receipts</h2>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Time</th><th>Capability</th><th>Action</th><th>Status</th><th>Proof</th></tr>
            </thead>
            <tbody>
              ${latestRows.length
                ? latestRows.map((row) => `<tr><td>${escapeHtml(row.timestamp || "")}</td><td>${escapeHtml(row.capability)}</td><td>${escapeHtml(row.action)}</td><td><span class="status">${escapeHtml(row.status)}</span></td><td><div>${escapeHtml(row.run_id)}</div><div class="path">${escapeHtml(row.artifact_path || "")}</div></td></tr>`).join("\n              ")
                : "<tr><td colspan=\"5\">No receipts found in local Pilot state.</td></tr>"}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </main>
  <script type="application/json" id="pilot-receipt-data">${escapeHtml(dataJson)}</script>
</body>
</html>
`;
}

const createArtifact: GoalCapabilityRunner = async ({ request, artifactDir }) => {
  const artifactPath = join(artifactDir, "step-1-goal-artifact.md");
  await writeFile(
    artifactPath,
    [
      "# Goal Execution Artifact",
      "",
      `Goal: ${request.goal.statement}`,
      "",
      "Local scoped execution completed by creating this bounded artifact.",
      "",
    ].join("\n"),
    "utf8",
  );

  return {
    capability: "create_artifact",
    action: "create_scoped_goal_artifact",
    action_summary: "Created a scoped local goal artifact.",
    artifact_path: artifactPath,
    evidence_message: "Approved local artifact exists and typed receipt was recorded.",
  };
};

const createPilotReceiptsDashboard: GoalCapabilityRunner = async ({ request, stateRoot, artifactDir, createdAt }) => {
  const rows = await readReceiptRows(stateRoot);
  const artifactPath = join(artifactDir, "pilot-receipts-dashboard.html");
  const capabilityCount = new Set(rows.map((row) => row.capability)).size;
  await writeFile(artifactPath, renderPilotReceiptsDashboard(request, rows, createdAt), "utf8");

  return {
    capability: "create_pilot_receipts_dashboard",
    action: "create_pilot_receipts_dashboard",
    action_summary: `Created a self-contained local Pilot receipts dashboard with ${rows.length} receipt rows.`,
    artifact_path: artifactPath,
    event_details: {
      receipt_rows: rows.length,
      receipt_capabilities: capabilityCount,
    },
    evidence_message: "Approved local Pilot receipts dashboard exists and typed receipt was recorded.",
  };
};

const createReviewNote: GoalCapabilityRunner = async ({ request, artifactDir }) => {
  const artifactPath = join(artifactDir, "review-note.md");
  await writeFile(
    artifactPath,
    [
      "# Pilot Review Note",
      "",
      `Goal: ${request.goal.statement}`,
      "",
      "This artifact records a local review note only. It does not claim semantic review, external validation, or task execution.",
      "",
      "Approved Scope:",
      ...(request.approval?.approved_scope || []).map((item) => `- ${item}`),
      "",
    ].join("\n"),
    "utf8",
  );

  return {
    capability: "create_review_note",
    action: "create_review_note",
    action_summary: "Created a local review note without overclaiming semantic review.",
    artifact_path: artifactPath,
    evidence_message: "Approved local review note exists and typed receipt was recorded.",
  };
};

function envFlag(name: string): boolean {
  return ["1", "true", "yes", "on"].includes(String(process.env[name] || "").trim().toLowerCase());
}

function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(String(process.env[name] || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envJsonArray(name: string): string[] {
  const raw = process.env[name];
  if (!raw?.trim()) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error(`${name} must be a JSON string array`);
  }
  return parsed;
}

function renderRunnerPrompt(request: GoalRequest, runId: string): string {
  return [
    "You are executing an approved OpenClaw Pilot goal.",
    "",
    `Pilot goal run: ${runId}`,
    `Goal: ${request.goal.statement}`,
    "",
    "Approved plan boundary:",
    ...request.plan.scope.map((item) => `- scope: ${item}`),
    ...request.plan.success_criteria.map((item) => `- success: ${item}`),
    ...request.plan.verification_gates.map((item) => `- verify: ${item}`),
    "",
    "Approved actions:",
    ...(request.approval?.approved_scope || []).map((item) => `- ${item}`),
    "",
    "Execution rules:",
    "- Execute the original approved request; do not replace it with a placeholder Pilot artifact.",
    "- If the goal names a concrete local file or artifact, create or modify that exact target within the approved boundary.",
    "- Verify concrete requested artifacts directly when possible, and report their paths in the final execution report.",
    "",
    "Stop and report instead of continuing if the work requires actions outside the approved plan.",
    "Return a concise execution report with changed files, checks run, failures, and remaining risks.",
    "",
  ].join("\n");
}

async function runSubprocess(options: {
  command: string;
  args: string[];
  input: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolvePromise({ exitCode, stdout, stderr, timedOut });
    });
    child.stdin.end(options.input);
  });
}

const runCodexSession: GoalCapabilityRunner = async ({ request, artifactDir, runId }) => {
  const prompt = renderRunnerPrompt(request, runId);
  const promptPath = join(artifactDir, "runner-prompt.md");
  const stdoutPath = join(artifactDir, "runner-stdout.txt");
  const stderrPath = join(artifactDir, "runner-stderr.txt");
  const resultPath = join(artifactDir, "runner-result.json");
  await writeFile(promptPath, prompt, "utf8");

  if (!envFlag("PILOT_SESSION_RUNNER_ENABLED")) {
    await writeFile(
      resultPath,
      `${JSON.stringify(
        {
          schema_version: "pilot.runner_result.v0",
          run_id: runId,
          status: "runner_disabled",
          prompt_path: promptPath,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    throw new GoalCapabilityError(
      "PILOT_SESSION_RUNNER_ENABLED is not true; refusing to execute approved session runner.",
      { artifact_path: resultPath, supporting_artifacts: [promptPath] },
    );
  }

  const command = process.env.PILOT_SESSION_RUNNER_COMMAND || "codex";
  const args = process.env.PILOT_SESSION_RUNNER_ARGS_JSON
    ? envJsonArray("PILOT_SESSION_RUNNER_ARGS_JSON")
    : ["exec", "--ask-for-approval", "never", "--sandbox", "workspace-write", "-"];
  const cwd = process.env.PILOT_SESSION_RUNNER_CWD || process.cwd();
  const timeoutMs = envInt("PILOT_SESSION_RUNNER_TIMEOUT_MS", 120000);

  const execution = await runSubprocess({
    command,
    args,
    input: prompt,
    cwd,
    env: {
      ...process.env,
      PILOT_RUN_ID: runId,
      PILOT_RUNNER_PROMPT_PATH: promptPath,
      PILOT_APPROVAL_REFERENCE: request.approval?.reference || "",
    },
    timeoutMs,
  });
  await writeFile(stdoutPath, execution.stdout, "utf8");
  await writeFile(stderrPath, execution.stderr, "utf8");
  await writeFile(
    resultPath,
    `${JSON.stringify(
      {
        schema_version: "pilot.runner_result.v0",
        run_id: runId,
        status: execution.timedOut ? "timed_out" : execution.exitCode === 0 ? "ok" : "failed",
        command,
        args,
        cwd,
        timeout_ms: timeoutMs,
        exit_code: execution.exitCode,
        timed_out: execution.timedOut,
        stdout_path: stdoutPath,
        stderr_path: stderrPath,
        prompt_path: promptPath,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  if (execution.timedOut) {
    throw new GoalCapabilityError(`session runner timed out after ${timeoutMs}ms`, {
      artifact_path: resultPath,
      supporting_artifacts: [promptPath, stdoutPath, stderrPath],
    });
  }
  if (execution.exitCode !== 0) {
    throw new GoalCapabilityError(`session runner exited with code ${execution.exitCode}`, {
      artifact_path: resultPath,
      supporting_artifacts: [promptPath, stdoutPath, stderrPath],
    });
  }

  return {
    capability: "run_codex_session",
    action: "run_codex_session",
    action_summary: "Ran the approved Codex/session runner vertical slice.",
    artifact_path: resultPath,
    supporting_artifacts: [promptPath, stdoutPath, stderrPath],
    event_details: {
      command,
      cwd,
      exit_code: execution.exitCode,
      timed_out: execution.timedOut,
    },
    evidence_message: "Approved session runner completed and runner result artifacts were recorded.",
  };
};

export const goalCapabilityRegistry: Record<GoalCapabilityName, GoalCapabilityRunner> = {
  create_artifact: createArtifact,
  create_pilot_receipts_dashboard: createPilotReceiptsDashboard,
  create_review_note: createReviewNote,
  run_codex_session: runCodexSession,
};

export function getGoalCapabilityRunner(capability: string): GoalCapabilityRunner | undefined {
  return goalCapabilityRegistry[capability as GoalCapabilityName];
}
