import { spawn } from "node:child_process";
import { deriveUserFacingPlanDraft } from "./user-facing-plan.js";
export class LocalPlannerProvider {
    kind = "local";
    draft(input) {
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
function positiveIntegerEnv(name, fallback) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function firstJsonObject(text) {
    const trimmed = text.trim();
    if (!trimmed)
        throw new Error("empty planner response");
    try {
        return JSON.parse(trimmed);
    }
    catch {
        const start = trimmed.indexOf("{");
        const end = trimmed.lastIndexOf("}");
        if (start < 0 || end <= start)
            throw new Error("planner response did not contain JSON");
        return JSON.parse(trimmed.slice(start, end + 1));
    }
}
function maybeString(value) {
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
function stringList(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === "string" && item.trim().length > 0);
}
function isDraft(value) {
    if (!value || typeof value !== "object")
        return false;
    const draft = value;
    return (typeof draft.title === "string" &&
        (draft.mode === "plan" || draft.mode === "goal" || draft.mode === "verify" || draft.mode === "conv") &&
        typeof draft.understood_request === "string" &&
        Array.isArray(draft.assumptions) &&
        Array.isArray(draft.approach) &&
        Array.isArray(draft.steps) &&
        Array.isArray(draft.verification) &&
        Array.isArray(draft.approval_boundary) &&
        Array.isArray(draft.not_doing_yet));
}
function normalizeProviderDraft(value, fallbackMode) {
    if (isDraft(value))
        return value;
    if (!value || typeof value !== "object")
        return undefined;
    const object = value;
    const title = maybeString(object.title);
    const understood = maybeString(object.understood_request) || maybeString(object.summary) || maybeString(object.goal);
    if (!title || !understood)
        return undefined;
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
            ? [maybeString(object.approval_boundary)]
            : [];
    return {
        title,
        mode: object.mode === "plan" || object.mode === "goal" || object.mode === "verify" || object.mode === "conv"
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
function parsePlannerResponse(stdout, fallbackMode) {
    const root = firstJsonObject(stdout);
    const payload = root && typeof root === "object" && "reply_text" in root && typeof root.reply_text === "string"
        ? firstJsonObject(root.reply_text)
        : root && typeof root === "object" && "message" in root && typeof root.message === "string"
            ? firstJsonObject(root.message)
            : root &&
                typeof root === "object" &&
                Array.isArray(root.payloads) &&
                typeof (root.payloads[0]?.text) === "string"
                ? firstJsonObject(root.payloads[0].text)
                : root;
    if (!payload || typeof payload !== "object")
        throw new Error("planner JSON payload must be an object");
    const object = payload;
    const directDraft = normalizeProviderDraft(object, fallbackMode);
    if (directDraft)
        return { kind: "draft", draft: directDraft };
    const nestedDraft = normalizeProviderDraft(object.draft, fallbackMode);
    if (nestedDraft)
        return { kind: "draft", draft: nestedDraft };
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
        if (draft)
            return { kind: "draft", draft };
    }
    if (object.kind === "interview") {
        const questions = stringList(object.questions).slice(0, 3);
        if (!questions.length)
            throw new Error("planner interview response requires questions");
        const draft = normalizeProviderDraft(object.draft, fallbackMode);
        return { kind: "interview", questions, summary: maybeString(object.summary), ...(draft ? { draft } : {}) };
    }
    if (object.kind === "unavailable")
        return { kind: "unavailable", reason: maybeString(object.reason) || "planner unavailable" };
    throw new Error("planner JSON payload has unsupported kind");
}
function plannerPrompt(input) {
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
        JSON.stringify({
            mode: input.mode,
            request: input.request,
            anchor: input.anchor,
            current_plan: input.plan,
            execution_plan: input.executionPlan,
            source: input.source,
            run_context: input.runContext,
            prior_interview_turns: input.priorInterviewTurns || [],
        }, null, 2),
    ].join("\n");
}
export class OpenClawOrchestratorPlannerProvider {
    kind = "orchestrator";
    command;
    timeoutMs;
    constructor(command = process.env.PILOT_PLANNER_PROVIDER_COMMAND?.trim() || "", timeoutMs = positiveIntegerEnv("PILOT_PLANNER_PROVIDER_TIMEOUT_MS", 60_000)) {
        this.command = command;
        this.timeoutMs = timeoutMs;
    }
    async draft(input) {
        return new Promise((resolve) => {
            const prompt = plannerPrompt(input);
            const child = this.command
                ? spawn(this.command, { shell: true, stdio: ["pipe", "pipe", "pipe"] })
                : spawn(process.env.PILOT_PLANNER_OPENCLAW_BIN?.trim() || "openclaw", [
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
                ], { stdio: ["ignore", "pipe", "pipe"] });
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
            child.stdout.on("data", (chunk) => {
                stdout += chunk;
            });
            child.stderr.on("data", (chunk) => {
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
                }
                catch (error) {
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
export function createDefaultPlannerProvider() {
    if (process.env.PILOT_PLANNER_PROVIDER?.trim().toLowerCase() === "orchestrator") {
        return new OpenClawOrchestratorPlannerProvider();
    }
    return new LocalPlannerProvider();
}
