import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LINEAGE_INDEX_RELATIVE_PATH } from "./lineage.js";
import { appendLineageRecord } from "./lineage.js";
import { readRunIndexEntries, shortRunId } from "./run-index.js";
const DEFAULT_RECOVERY_STALE_AFTER_MS = 30 * 60 * 1000;
function isRouteCommand(value) {
    return (value === "/plan" ||
        value === "/verify" ||
        value === "/conv" ||
        value === "/goal" ||
        value === "approve" ||
        value === "list" ||
        value === "status" ||
        value === "resume" ||
        value === "cancel");
}
function isLineageRecord(value) {
    if (!value || typeof value !== "object")
        return false;
    const record = value;
    return (record.schema_version === "pilot.lineage.v0" &&
        typeof record.run_id === "string" &&
        typeof record.short_run_id === "string" &&
        isRouteCommand(record.command) &&
        typeof record.status === "string" &&
        typeof record.created_at === "string" &&
        typeof record.artifact_dir === "string" &&
        typeof record.resume_hint === "string");
}
function cleanReference(reference) {
    return reference.trim().replace(/^["'`]+|["'`.,]+$/g, "");
}
async function readJsonIfExists(path) {
    try {
        return JSON.parse(await readFile(path, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
async function existingArtifacts(artifactDir) {
    const names = [
        "goal.json",
        "goal-run.json",
        "plan.md",
        "verification.json",
        "verify-checkpoint.json",
        "conv.json",
        "conv-request.json",
        "conv-checkpoint.json",
        "conv-result.json",
        "cancel.json",
        "resume.json",
        "resume-lock.json",
        "auto-resume-attempt.json",
        "receipts.jsonl",
        "lineage.jsonl",
        "events.jsonl",
        "final.md",
        "post-execution-evidence.json",
        "post-execution-conv-request.json",
        "post-convergence-evidence.json",
    ];
    const existing = [];
    for (const name of names) {
        const path = join(artifactDir, name);
        try {
            const info = await stat(path);
            if (info.isFile())
                existing.push(path);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
    }
    return existing;
}
function isTerminalCompletedStatus(status) {
    return (status === "completed" ||
        status === "sufficient_evidence" ||
        status === "completed_verified" ||
        status === "completed_after_convergence" ||
        status === "completed_with_risks");
}
function recoveryStaleAfterMs() {
    const raw = process.env.PILOT_RECOVERY_STALE_AFTER_MS;
    if (!raw)
        return DEFAULT_RECOVERY_STALE_AFTER_MS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0)
        return DEFAULT_RECOVERY_STALE_AFTER_MS;
    return parsed;
}
function runAgeMs(createdAt, checkedAt) {
    const created = Date.parse(createdAt);
    if (Number.isNaN(created))
        return 0;
    return Math.max(0, checkedAt.getTime() - created);
}
function recoveryVisibilityFor(status, createdAt) {
    const checkedAt = new Date();
    const staleAfterMs = recoveryStaleAfterMs();
    const ageMs = runAgeMs(createdAt, checkedAt);
    if (status === "cancelled") {
        return {
            status: "cancelled",
            checked_at: checkedAt.toISOString(),
            age_ms: ageMs,
            stale_after_ms: staleAfterMs,
            timeout_visible: false,
            restart_visible: true,
            hint: "Run is cancelled. Create a new /plan or /goal if work should continue.",
        };
    }
    if (isTerminalCompletedStatus(status)) {
        return {
            status: "terminal",
            checked_at: checkedAt.toISOString(),
            age_ms: ageMs,
            stale_after_ms: staleAfterMs,
            timeout_visible: false,
            restart_visible: true,
            hint: "Run is terminal. Use status <Run> to inspect artifacts; no automatic resume is needed.",
        };
    }
    if (ageMs >= staleAfterMs) {
        return {
            status: "stale",
            checked_at: checkedAt.toISOString(),
            age_ms: ageMs,
            stale_after_ms: staleAfterMs,
            timeout_visible: true,
            restart_visible: true,
            hint: "Run has not advanced within the recovery freshness window. Inspect status, then choose resume for guidance, cancel the stale run, or start a new /plan or /goal.",
        };
    }
    return {
        status: "fresh",
        checked_at: checkedAt.toISOString(),
        age_ms: ageMs,
        stale_after_ms: staleAfterMs,
        timeout_visible: false,
        restart_visible: true,
        hint: "Run is within the recovery freshness window. Follow the lifecycle next action or resume hint.",
    };
}
export async function readLineageRecords(stateRoot) {
    const indexPath = join(stateRoot, LINEAGE_INDEX_RELATIVE_PATH);
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
        .filter(isLineageRecord);
}
function latestByRun(records) {
    const byRun = new Map();
    for (const record of records) {
        const previous = byRun.get(record.run_id);
        if (!previous || record.created_at >= previous.created_at)
            byRun.set(record.run_id, record);
    }
    return [...byRun.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
}
function summaryFromRecord(record) {
    return {
        run_id: record.run_id,
        short_run_id: record.short_run_id || shortRunId(record.run_id),
        command: record.command,
        status: record.status,
        created_at: record.created_at,
        artifact_dir: record.artifact_dir,
        parent_run_id: record.parent_run_id,
        approval_reference: record.approval_reference,
        resume_hint: record.resume_hint,
        recovery: recoveryVisibilityFor(record.status, record.metadata?.last_progress_at || record.created_at),
    };
}
function summaryFromIndexEntry(entry) {
    return {
        run_id: entry.run_id,
        short_run_id: entry.short_run_id,
        command: entry.command,
        status: entry.status,
        created_at: entry.created_at,
        artifact_dir: entry.artifact_dir,
        resume_hint: entry.next_action,
        recovery: recoveryVisibilityFor(entry.status, entry.created_at),
    };
}
function indexForRun(entries, runId) {
    return entries.filter((entry) => entry.run_id === runId).at(-1);
}
export async function listRecoveryRuns(stateRoot, limit = 10) {
    const lineage = latestByRun(await readLineageRecords(stateRoot));
    if (lineage.length > 0)
        return lineage.slice(0, limit).map(summaryFromRecord);
    const entries = await readRunIndexEntries(stateRoot);
    return entries
        .slice()
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, limit)
        .map(summaryFromIndexEntry);
}
export async function resolveRecoveryRun(stateRoot, reference) {
    const cleaned = cleanReference(reference);
    if (!cleaned)
        return { status: "not_found", reference: cleaned };
    const [lineage, runIndex] = await Promise.all([readLineageRecords(stateRoot), readRunIndexEntries(stateRoot)]);
    const candidates = latestByRun(lineage);
    const indexMatches = runIndex.filter((entry) => entry.run_id === cleaned || entry.short_run_id === cleaned);
    if (indexMatches.length === 1) {
        const indexedRun = candidates.find((record) => record.run_id === indexMatches[0].run_id);
        if (indexedRun) {
            const allForRun = lineage.filter((record) => record.run_id === indexedRun.run_id);
            const goalRun = await readJsonIfExists(join(indexedRun.artifact_dir, "goal-run.json"));
            return {
                status: "found",
                run: {
                    ...summaryFromRecord(indexedRun),
                    lineage_records: allForRun.length,
                    latest_lineage: indexedRun,
                    run_index_status: indexMatches[0].status,
                    source: {
                        channel: indexMatches[0].channel,
                        chat_id: indexMatches[0].chat_id,
                        sender_id: indexMatches[0].sender_id,
                        source_message_id: indexMatches[0].source_message_id,
                        source_update_id: indexMatches[0].source_update_id,
                    },
                    lifecycle: goalRun?.lifecycle,
                    evidence_pointers: indexedRun.evidence_pointers,
                    receipt_pointers: indexedRun.receipt_pointers || [],
                    available_artifacts: await existingArtifacts(indexedRun.artifact_dir),
                },
            };
        }
    }
    const matches = candidates.filter((record) => record.run_id === cleaned || record.short_run_id === cleaned);
    if (matches.length === 0) {
        if (indexMatches.length === 0)
            return { status: "not_found", reference: cleaned };
        if (indexMatches.length > 1) {
            return {
                status: "ambiguous",
                reference: cleaned,
                matches: indexMatches.map(summaryFromIndexEntry),
            };
        }
        const entry = indexMatches[0];
        return {
            status: "found",
            run: {
                ...summaryFromIndexEntry(entry),
                lineage_records: 0,
                run_index_status: entry.status,
                source: {
                    channel: entry.channel,
                    chat_id: entry.chat_id,
                    sender_id: entry.sender_id,
                    source_message_id: entry.source_message_id,
                    source_update_id: entry.source_update_id,
                },
                evidence_pointers: [],
                receipt_pointers: [],
                available_artifacts: await existingArtifacts(entry.artifact_dir),
            },
        };
    }
    if (matches.length > 1 && matches.every((record) => record.run_id !== cleaned)) {
        return { status: "ambiguous", reference: cleaned, matches: matches.map(summaryFromRecord) };
    }
    const latest = matches.find((record) => record.run_id === cleaned) || matches[0];
    const allForRun = lineage.filter((record) => record.run_id === latest.run_id);
    const indexEntry = indexForRun(runIndex, latest.run_id);
    const goalRun = await readJsonIfExists(join(latest.artifact_dir, "goal-run.json"));
    return {
        status: "found",
        run: {
            ...summaryFromRecord(latest),
            lineage_records: allForRun.length,
            latest_lineage: latest,
            run_index_status: indexEntry?.status,
            source: indexEntry
                ? {
                    channel: indexEntry.channel,
                    chat_id: indexEntry.chat_id,
                    sender_id: indexEntry.sender_id,
                    source_message_id: indexEntry.source_message_id,
                    source_update_id: indexEntry.source_update_id,
                }
                : undefined,
            lifecycle: goalRun?.lifecycle,
            evidence_pointers: latest.evidence_pointers,
            receipt_pointers: latest.receipt_pointers || [],
            available_artifacts: await existingArtifacts(latest.artifact_dir),
        },
    };
}
export async function cancelRecoveryRun(stateRoot, reference, options = {}) {
    const resolution = await resolveRecoveryRun(stateRoot, reference);
    if (resolution.status !== "found")
        return resolution;
    const run = resolution.run;
    if (run.status === "cancelled")
        return { status: "already_cancelled", run };
    if (isTerminalCompletedStatus(run.status)) {
        return {
            status: "not_cancelable",
            run,
            reason: `Run is already terminal: ${run.status}.`,
        };
    }
    const createdAt = new Date().toISOString();
    const reason = options.reason?.trim() || "User requested cancellation.";
    const cancelArtifact = join(run.artifact_dir, "cancel.json");
    await writeFile(cancelArtifact, `${JSON.stringify({
        schema_version: "pilot.recovery_cancel.v0",
        created_at: createdAt,
        run_id: run.run_id,
        short_run_id: run.short_run_id,
        previous_status: run.status,
        reason,
        metadata: options.metadata || {},
    }, null, 2)}\n`, "utf8");
    await appendLineageRecord(stateRoot, {
        schema_version: "pilot.lineage.v0",
        created_at: createdAt,
        record_type: "recovery",
        command: "cancel",
        run_id: run.run_id,
        short_run_id: run.short_run_id,
        status: "cancelled",
        state_root: stateRoot,
        artifact_dir: run.artifact_dir,
        parent_run_id: run.parent_run_id,
        approval_reference: run.approval_reference,
        evidence_pointers: [cancelArtifact],
        receipt_pointers: [],
        resume_hint: "Run is cancelled. Create a new /plan or /goal if work should continue.",
        metadata: {
            previous_status: run.status,
            reason,
        },
    });
    const refreshed = await resolveRecoveryRun(stateRoot, run.run_id);
    return {
        status: "cancelled",
        run: refreshed.status === "found" ? refreshed.run : run,
        cancel_artifact: cancelArtifact,
        previous_status: run.status,
    };
}
export async function isRecoveryRunCancelled(stateRoot, reference) {
    const resolution = await resolveRecoveryRun(stateRoot, reference);
    return resolution.status === "found" && resolution.run.status === "cancelled";
}
export async function createResumeDirective(stateRoot, run, options) {
    if (run.recovery.status === "cancelled") {
        return { status: "not_resumable", run, reason: "Run is cancelled." };
    }
    if (run.recovery.status === "terminal") {
        return { status: "not_resumable", run, reason: "Run is already terminal." };
    }
    const createdAt = new Date().toISOString();
    const resumeArtifact = join(run.artifact_dir, "resume.json");
    await writeFile(resumeArtifact, `${JSON.stringify({
        schema_version: "pilot.recovery_resume_directive.v0",
        created_at: createdAt,
        run_id: run.run_id,
        short_run_id: run.short_run_id,
        current_status: run.status,
        recovery_status: run.recovery.status,
        artifact_dir: run.artifact_dir,
        next_action: options.nextAction,
        risks: options.risks,
        automatic_execution_performed: false,
        process_resume_supported: false,
        runner_resume_supported: false,
        note: "This directive is a durable handoff for advisory recovery. It does not resume a process or rerun a session.",
        metadata: options.metadata || {},
    }, null, 2)}\n`, "utf8");
    await appendLineageRecord(stateRoot, {
        schema_version: "pilot.lineage.v0",
        created_at: createdAt,
        record_type: "recovery",
        command: "resume",
        run_id: run.run_id,
        short_run_id: run.short_run_id,
        status: run.status,
        state_root: stateRoot,
        artifact_dir: run.artifact_dir,
        parent_run_id: run.parent_run_id,
        approval_reference: run.approval_reference,
        evidence_pointers: [resumeArtifact],
        receipt_pointers: [],
        resume_hint: options.nextAction,
        metadata: {
            recovery_action: "resume_directive",
            recovery_status: run.recovery.status,
            last_progress_at: run.latest_lineage?.metadata?.last_progress_at || run.latest_lineage?.created_at || run.created_at,
            original_command: run.command,
        },
    });
    const refreshed = await resolveRecoveryRun(stateRoot, run.run_id);
    return {
        status: "created",
        run: refreshed.status === "found" ? refreshed.run : run,
        resume_artifact: resumeArtifact,
    };
}
