import { spawn } from "node:child_process";
import type { CommandPlanAnchor } from "../plan/generate.ts";
import type {
  CommonPlanContract,
  ExecutionPlan,
  InterviewTurn,
  PlanMode,
  PlannerRunContext,
  PlannerSourceContext,
  UserFacingPlanDraft,
} from "../types.ts";
import { deriveUserFacingPlanDraft } from "./user-facing-plan.ts";

export type PlannerProviderInput = {
  mode: PlanMode;
  request: string;
  plan: CommonPlanContract;
  anchor?: CommandPlanAnchor;
  executionPlan?: ExecutionPlan;
  source?: PlannerSourceContext;
  runContext: PlannerRunContext;
  priorInterviewTurns?: InterviewTurn[];
};

export type PlannerProviderResult =
  | {
      status: "draft_ready";
      draft: UserFacingPlanDraft;
      provider_kind: "local" | "orchestrator" | "test";
    }
  | {
      status: "needs_clarification";
      draft?: UserFacingPlanDraft;
      questions: string[];
      summary?: string;
      provider_kind: "local" | "orchestrator" | "test";
    }
  | {
      status: "unavailable";
      reason: string;
      provider_kind: "orchestrator" | "test";
    };

export interface PlannerProvider {
  readonly kind: "local" | "orchestrator" | "test";
  draft(input: PlannerProviderInput): Promise<PlannerProviderResult> | PlannerProviderResult;
}

export class LocalPlannerProvider implements PlannerProvider {
  readonly kind = "local" as const;

  draft(input: PlannerProviderInput): PlannerProviderResult {
    const draft = deriveUserFacingPlanDraft(input);
    if (draft.open_questions?.length) {
      return {
        status: "needs_clarification",
        draft,
        questions: draft.open_questions,
        provider_kind: this.kind,
      };
    }
    return {
      status: "draft_ready",
      draft,
      provider_kind: this.kind,
    };
  }
}

type ExternalPlannerResponse =
  | { kind: "draft"; draft: UserFacingPlanDraft }
  | { kind: "interview"; questions: string[]; summary?: string; draft?: UserFacingPlanDraft }
  | { kind: "unavailable"; reason: string };

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function firstJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("empty planner response");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("planner response did not contain JSON");
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

function maybeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function isDraft(value: unknown): value is UserFacingPlanDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<UserFacingPlanDraft>;
  return (
    typeof draft.title === "string" &&
    (draft.mode === "plan" || draft.mode === "goal" || draft.mode === "verify" || draft.mode === "conv") &&
    typeof draft.understood_request === "string" &&
    Array.isArray(draft.assumptions) &&
    Array.isArray(draft.approach) &&
    Array.isArray(draft.steps) &&
    Array.isArray(draft.verification) &&
    Array.isArray(draft.approval_boundary) &&
    Array.isArray(draft.not_doing_yet)
  );
}

function normalizeProviderDraft(value: unknown, fallbackMode: PlanMode): UserFacingPlanDraft | undefined {
  if (isDraft(value)) return value;
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  const title = maybeString(object.title);
  const understood = maybeString(object.understood_request) || maybeString(object.summary) || maybeString(object.goal);
  if (!title || !understood) return undefined;
  const approach = stringList(object.approach);
  const steps = stringList(object.steps);
  const verification = stringList(object.verification);
  const successCriteria = stringList(object.success_criteria);
  const scope = stringList(object.scope);
  const outOfScope = stringList(object.not_doing_yet).length ? stringList(object.not_doing_yet) : stringList(object.out_of_scope);
  const assumptions = stringList(object.assumptions).length ? stringList(object.assumptions) : stringList(object.risks_assumptions);
  const approvalBoundary = stringList(object.approval_boundary).length
    ? stringList(object.approval_boundary)
    : maybeString(object.approval_boundary)
      ? [maybeString(object.approval_boundary) as string]
      : [];

  return {
    title,
    mode:
      object.mode === "plan" || object.mode === "goal" || object.mode === "verify" || object.mode === "conv"
        ? object.mode
        : fallbackMode,
    understood_request: understood,
    assumptions,
    approach: approach.length ? approach : scope.length ? scope : [understood],
    steps,
    verification: verification.length ? verification : successCriteria,
    approval_boundary: approvalBoundary,
    not_doing_yet: outOfScope,
    ...(stringList(object.open_questions).length ? { open_questions: stringList(object.open_questions).slice(0, 3) } : {}),
  };
}

function parsePlannerResponse(stdout: string, fallbackMode: PlanMode): ExternalPlannerResponse {
  const root = firstJsonObject(stdout);
  const payload =
    root && typeof root === "object" && "reply_text" in root && typeof (root as { reply_text?: unknown }).reply_text === "string"
      ? firstJsonObject((root as { reply_text: string }).reply_text)
      : root && typeof root === "object" && "message" in root && typeof (root as { message?: unknown }).message === "string"
        ? firstJsonObject((root as { message: string }).message)
        : root &&
            typeof root === "object" &&
            Array.isArray((root as { payloads?: unknown }).payloads) &&
            typeof ((root as { payloads: Array<{ text?: unknown }> }).payloads[0]?.text) === "string"
          ? firstJsonObject((root as { payloads: Array<{ text: string }> }).payloads[0].text)
        : root;

  if (!payload || typeof payload !== "object") throw new Error("planner JSON payload must be an object");
  const object = payload as Record<string, unknown>;
  const directDraft = normalizeProviderDraft(object, fallbackMode);
  if (directDraft) return { kind: "draft", draft: directDraft };
  const nestedDraft = normalizeProviderDraft(object.draft, fallbackMode);
  if (nestedDraft) return { kind: "draft", draft: nestedDraft };
  if (stringList(object.questions).length) {
    const draft = normalizeProviderDraft(object.draft, fallbackMode);
    return {
      kind: "interview",
      questions: stringList(object.questions).slice(0, 3),
      summary: maybeString(object.summary),
      ...(draft ? { draft } : {}),
    };
  }
  if (object.kind === "draft") {
    const draft = normalizeProviderDraft(object.draft, fallbackMode);
    if (draft) return { kind: "draft", draft };
  }
  if (object.kind === "interview") {
    const questions = stringList(object.questions).slice(0, 3);
    if (!questions.length) throw new Error("planner interview response requires questions");
    const draft = normalizeProviderDraft(object.draft, fallbackMode);
    return { kind: "interview", questions, summary: maybeString(object.summary), ...(draft ? { draft } : {}) };
  }
  if (object.kind === "unavailable") return { kind: "unavailable", reason: maybeString(object.reason) || "planner unavailable" };
  throw new Error("planner JSON payload has unsupported kind");
}

function plannerPrompt(input: PlannerProviderInput): string {
  return [
    "You are the OpenClaw Pilot planning provider.",
    "Return only JSON. No markdown, no prose, no tools.",
    "Use exactly one of these shapes:",
    '{"kind":"draft","draft":{"title":"...","mode":"goal|verify|conv|plan","understood_request":"...","assumptions":["..."],"approach":["..."],"steps":["..."],"verification":["..."],"approval_boundary":["..."],"not_doing_yet":["..."],"open_questions":["optional"]}}',
    '{"kind":"interview","questions":["..."],"summary":"...","draft":{"title":"...","mode":"goal|verify|conv|plan","understood_request":"...","assumptions":["..."],"approach":["..."],"steps":["..."],"verification":["..."],"approval_boundary":["..."],"not_doing_yet":["..."]}}',
    '{"kind":"unavailable","reason":"..."}',
    "Do not execute, approve, collect evidence, send messages, or claim verification results.",
    "Use the raw request and context envelope to produce a user-facing planning draft or bounded interview questions.",
    "",
    JSON.stringify(
      {
        mode: input.mode,
        request: input.request,
        anchor: input.anchor,
        current_plan: input.plan,
        execution_plan: input.executionPlan,
        source: input.source,
        run_context: input.runContext,
        prior_interview_turns: input.priorInterviewTurns || [],
      },
      null,
      2,
    ),
  ].join("\n");
}

export class OpenClawOrchestratorPlannerProvider implements PlannerProvider {
  readonly kind = "orchestrator" as const;
  private readonly command: string;
  private readonly timeoutMs: number;

  constructor(command = process.env.PILOT_PLANNER_PROVIDER_COMMAND?.trim() || "", timeoutMs = positiveIntegerEnv("PILOT_PLANNER_PROVIDER_TIMEOUT_MS", 60_000)) {
    this.command = command;
    this.timeoutMs = timeoutMs;
  }

  async draft(input: PlannerProviderInput): Promise<PlannerProviderResult> {
    return new Promise((resolve) => {
      const prompt = plannerPrompt(input);
      const child = this.command
        ? spawn(this.command, { shell: true, stdio: ["pipe", "pipe", "pipe"] })
        : spawn(
            process.env.PILOT_PLANNER_OPENCLAW_BIN?.trim() || "openclaw",
            [
              "agent",
              "--local",
              "--json",
              "--agent",
              process.env.PILOT_PLANNER_OPENCLAW_AGENT?.trim() || "main",
              "--session-key",
              process.env.PILOT_PLANNER_OPENCLAW_SESSION_KEY?.trim() || "agent:main:pilot-planner",
              "--timeout",
              String(Math.max(1, Math.ceil(this.timeoutMs / 1000))),
              "--message",
              prompt,
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        resolve({
          status: "unavailable",
          provider_kind: this.kind,
          reason: `Planner provider timed out after ${this.timeoutMs}ms.`,
        });
      }, this.timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        resolve({ status: "unavailable", provider_kind: this.kind, reason: error.message });
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          resolve({
            status: "unavailable",
            provider_kind: this.kind,
            reason: stderr.trim() || `Planner provider exited with code ${code}.`,
          });
          return;
        }
        try {
          const parsed = parsePlannerResponse(stdout, input.mode);
          if (parsed.kind === "draft") {
            resolve({ status: "draft_ready", draft: parsed.draft, provider_kind: this.kind });
            return;
          }
          if (parsed.kind === "interview") {
            resolve({
              status: "needs_clarification",
              questions: parsed.questions,
              summary: parsed.summary,
              ...(parsed.draft ? { draft: parsed.draft } : {}),
              provider_kind: this.kind,
            });
            return;
          }
          resolve({ status: "unavailable", reason: parsed.reason, provider_kind: this.kind });
        } catch (error) {
          resolve({
            status: "unavailable",
            provider_kind: this.kind,
            reason: error instanceof Error ? error.message : "Planner provider returned malformed output.",
          });
        }
      });
      if (this.command) {
        child.stdin?.end(prompt);
      }
    });
  }
}

export function createDefaultPlannerProvider(): PlannerProvider {
  if (process.env.PILOT_PLANNER_PROVIDER?.trim().toLowerCase() === "orchestrator") {
    return new OpenClawOrchestratorPlannerProvider();
  }
  return new LocalPlannerProvider();
}
