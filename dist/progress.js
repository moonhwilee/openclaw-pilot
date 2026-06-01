import { shortRunId } from "./state/run-index.js";
const priorities = ["P0", "P1", "P2", "P3"];
function compact(lines) {
    return lines.filter(Boolean).slice(0, 8);
}
function priorityCountsFromVerification(findings) {
    const actionable = findings.filter((finding) => finding.severity !== "info");
    if (actionable.length === 0)
        return undefined;
    const counts = Object.fromEntries(priorities.map((priority) => [priority, 0]));
    for (const finding of actionable)
        counts[finding.priority || "P2"] += 1;
    return priorities.map((priority) => `${priority} ${counts[priority]}`).join(", ");
}
function priorityCountsFromConv(findings) {
    const open = findings.filter((finding) => finding.status === "open");
    if (open.length === 0)
        return undefined;
    const counts = Object.fromEntries(priorities.map((priority) => [priority, 0]));
    for (const finding of open)
        counts[finding.priority || "P2"] += 1;
    return priorities.map((priority) => `${priority} ${counts[priority]}`).join(", ");
}
function goalMilestoneLine(result) {
    const milestones = result.request.execution_plan?.goal_milestones || [];
    if (milestones.length === 0)
        return undefined;
    const sliceCount = milestones.reduce((count, milestone) => count + milestone.slice_ids.length, 0);
    const active = milestones.find((milestone) => !["converged", "blocked"].includes(milestone.status)) || milestones.at(-1);
    if (!active)
        return `Goal milestones: ${milestones.length} phases, ${sliceCount} slices`;
    return `Goal phase: ${active.phase_index}/${milestones.length} ${active.goal_phase} (${active.status}, ${sliceCount} slices)`;
}
export function progressLinesForVerification(result) {
    const findingCounts = priorityCountsFromVerification(result.findings);
    return compact([
        `Run: ${shortRunId(result.run_id)}`,
        `Verify: ${result.semantic_verdict === "not_requested" ? result.verdict : `${result.semantic_verdict}/${result.verdict}`}`,
        result.reviewer_summary.required
            ? `Reviewers: content review ${result.reviewer_summary.reviewer_count}/${result.reviewer_summary.minimum_required} (${result.reviewer_summary.status})`
            : "Reviewers: content review not requested",
        findingCounts
            ? `Findings: ${findingCounts}`
            : result.reviewer_summary.required
                ? "Findings: no actionable findings"
                : "Findings: content review not performed",
    ]);
}
export function progressLinesForConv(result, checkpoint) {
    const maxRounds = checkpoint?.max_rounds;
    const roundText = maxRounds ? `${result.rounds.length}/${maxRounds}` : String(result.rounds.length);
    const open = result.findings.filter((finding) => finding.status === "open").length;
    const reduced = result.findings.filter((finding) => finding.status === "reduced").length;
    const lastRound = result.rounds.at(-1);
    return compact([
        `Run: ${shortRunId(result.run_id)}`,
        `Conv: round ${roundText} (${result.status})`,
        checkpoint && checkpoint.status !== "completed" ? `Next round: ${checkpoint.next_round}/${checkpoint.max_rounds}` : "",
        lastRound?.summary
            ? `Round summary: ${lastRound.summary.prior_issue_resolution}; next ${lastRound.summary.next_action}`
            : lastRound
                ? `Round summary: ${lastRound.verdict} - ${lastRound.action_summary}`
                : "Round summary: no rounds run",
        `Findings: open ${open}, reduced ${reduced}${priorityCountsFromConv(result.findings) ? `; ${priorityCountsFromConv(result.findings)}` : ""}`,
    ]);
}
export function progressLinesForGoal(result) {
    const lifecycle = result.lifecycle;
    const executionSteps = result.request.execution_plan?.steps.length || 0;
    const findingCounts = priorityCountsFromVerification(result.findings);
    return compact([
        `Run: ${shortRunId(result.run_id)}`,
        goalMilestoneLine(result) || "",
        lifecycle ? `Lifecycle: ${lifecycle.current_phase} (${lifecycle.user_status})` : `Lifecycle: ${result.status}`,
        executionSteps > 0 ? `Execution: ${result.steps.length}/${executionSteps} approved steps` : `Execution: ${result.steps.length} steps`,
        result.post_execution_verification
            ? `Verify: post-execution ${result.post_execution_verification.verdict}`
            : result.steps.length > 0
                ? "Verify: pending"
                : "",
        result.post_execution_convergence
            ? `Conv: ${result.post_execution_convergence.rounds} rounds (${result.post_execution_convergence.status})`
            : "",
        result.post_convergence_verification ? `Reverify: ${result.post_convergence_verification.verdict}` : "",
        findingCounts ? `Findings: ${findingCounts}` : "Findings: no actionable findings",
    ]);
}
export function progressLinesForRecovery(run, artifacts = {}) {
    if (artifacts.goalRun)
        return progressLinesForGoal(artifacts.goalRun);
    if (artifacts.convResult)
        return progressLinesForConv(artifacts.convResult, artifacts.convCheckpoint);
    if (artifacts.verification)
        return progressLinesForVerification(artifacts.verification);
    if (artifacts.convCheckpoint) {
        const checkpoint = artifacts.convCheckpoint;
        const open = checkpoint.findings.filter((finding) => finding.status === "open").length;
        const reduced = checkpoint.findings.filter((finding) => finding.status === "reduced").length;
        return compact([
            `Run: ${run.short_run_id}`,
            `Conv: round ${checkpoint.rounds.length}/${checkpoint.max_rounds} (${checkpoint.status})`,
            checkpoint.status !== "completed" ? `Next round: ${checkpoint.next_round}/${checkpoint.max_rounds}` : "",
            `Findings: open ${open}, reduced ${reduced}${priorityCountsFromConv(checkpoint.findings) ? `; ${priorityCountsFromConv(checkpoint.findings)}` : ""}`,
            `Recovery: ${run.recovery.status}`,
        ]);
    }
    return compact([
        `Run: ${run.short_run_id}`,
        run.lifecycle ? `Lifecycle: ${run.lifecycle.current_phase} (${run.lifecycle.user_status})` : `Lifecycle: ${run.status}`,
        `Recovery: ${run.recovery.status}`,
        `Lineage: ${run.lineage_records} records`,
    ]);
}
