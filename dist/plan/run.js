import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { DEFAULT_PROFILE, defaultStateRoot } from "../config.js";
import { createRunId, eventLine, prepareRunDirectory, renderFinalMarkdown, renderPlanMarkdown, writeJson } from "../artifacts.js";
import { validateCommonPlanContract, validateGoalArtifact } from "../schema/index.js";
import { isPhase1TerminalStatus } from "../state/index.js";
import { appendLineageRecord } from "../state/lineage.js";
import { shortRunId } from "../state/run-index.js";
import { buildPlan } from "./generate.js";
export async function runPlan(options) {
    const request = options.request.trim();
    if (!request) {
        throw new Error("pilot plan requires a request");
    }
    const stateRoot = options.stateRoot || defaultStateRoot();
    const now = options.now || new Date();
    const runId = createRunId(request, now);
    const artifactDir = await prepareRunDirectory(stateRoot, runId);
    const createdAt = now.toISOString();
    const { status, ambiguityQuestions, plan } = buildPlan(request);
    if (!isPhase1TerminalStatus(status)) {
        throw new Error(`Phase 1 cannot finish with status: ${status}`);
    }
    const validationErrors = validateCommonPlanContract(plan);
    if (validationErrors.length > 0) {
        throw new Error(`generated plan failed validation: ${validationErrors.join("; ")}`);
    }
    const goal = {
        schema_version: "pilot.goal.v0",
        run_id: runId,
        request,
        profile: DEFAULT_PROFILE,
        status,
        state_root: stateRoot,
        artifact_dir: artifactDir,
        created_at: createdAt,
        ambiguity_questions: ambiguityQuestions,
    };
    const goalValidationErrors = validateGoalArtifact(goal);
    if (goalValidationErrors.length > 0) {
        throw new Error(`generated goal failed validation: ${goalValidationErrors.join("; ")}`);
    }
    const events = [
        {
            timestamp: createdAt,
            run_id: runId,
            event: "intake",
            status: "ok",
            details: { profile: DEFAULT_PROFILE },
        },
        {
            timestamp: createdAt,
            run_id: runId,
            event: "plan_created",
            status,
            details: { execution: "not_performed" },
        },
        {
            timestamp: createdAt,
            run_id: runId,
            event: "completed",
            status,
            details: { terminal_state: status },
        },
    ];
    const files = {
        goal: join(artifactDir, "goal.json"),
        plan: join(artifactDir, "plan.md"),
        events: join(artifactDir, "events.jsonl"),
        final: join(artifactDir, "final.md"),
    };
    await writeJson(files.goal, goal);
    await writeFile(files.plan, renderPlanMarkdown(plan), "utf8");
    await writeFile(files.events, events.map(eventLine).join(""), "utf8");
    await writeFile(files.final, renderFinalMarkdown(goal), "utf8");
    const lineage = await appendLineageRecord(stateRoot, {
        schema_version: "pilot.lineage.v0",
        created_at: createdAt,
        record_type: "run",
        command: "/plan",
        run_id: runId,
        short_run_id: shortRunId(runId),
        status,
        state_root: stateRoot,
        artifact_dir: artifactDir,
        evidence_pointers: Object.values(files),
        resume_hint: status === "completed_plan"
            ? `Review the plan, then approve ${shortRunId(runId)} if it should execute.`
            : "Answer ambiguity questions, then rerun /plan or /goal.",
        metadata: {
            profile: DEFAULT_PROFILE,
            execution: "not_performed",
        },
    });
    return {
        run_id: runId,
        status,
        artifact_dir: artifactDir,
        goal,
        plan,
        created_files: [...Object.values(files), lineage.run_path],
    };
}
