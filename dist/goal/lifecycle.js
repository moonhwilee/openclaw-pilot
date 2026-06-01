function postExecutionVerified(result) {
    return result.post_execution_verification?.verdict === "sufficient_evidence";
}
function postConvergenceVerified(result) {
    return result.post_convergence_verification?.verdict === "sufficient_evidence";
}
function deriveUserStatus(result) {
    if (result.status !== "completed")
        return result.status;
    if (postConvergenceVerified(result))
        return "completed_after_convergence";
    if (postExecutionVerified(result))
        return "completed_verified";
    return "completed_with_risks";
}
function deriveCurrentPhase(result) {
    if (result.status === "awaiting_approval")
        return "approve";
    if (result.post_convergence_verification)
        return "report";
    if (result.post_execution_convergence)
        return "reverify";
    if (result.post_execution_verification)
        return "report";
    if (result.steps.length > 0)
        return "report";
    return "execute";
}
function deriveNextAction(status, result) {
    if (status === "awaiting_approval") {
        return "Approve the concrete plan before execution, or revise the plan if the boundaries are wrong.";
    }
    if (status === "completed_verified") {
        return "Use receipts, lifecycle, verification artifacts, and final.md as proof for completion.";
    }
    if (status === "completed_after_convergence") {
        return "Use the convergence and re-verification artifacts as proof, then continue only if a new goal is needed.";
    }
    if (status === "completed_with_risks") {
        return "Inspect final.md and remaining findings before treating the goal as fully verified.";
    }
    if (status === "needs_evidence") {
        return "Provide or generate the missing evidence, then retry /goal or run /verify on the updated evidence packet.";
    }
    if (status === "needs_revision") {
        return "Revise the output or evidence against the listed findings, then rerun /goal or /conv with a tighter anchor.";
    }
    if (status === "needs_user_decision") {
        return "Resolve the listed user decision before continuing execution.";
    }
    const firstFinding = result.findings.find((finding) => finding.severity !== "info");
    return firstFinding
        ? `Inspect the blocker first: ${firstFinding.code}.`
        : "Inspect the blocker in goal-run.json before retrying.";
}
function lifecycleSteps(result) {
    const approved = result.request.approval?.approved === true;
    const executable = approved && result.status !== "awaiting_approval";
    const verification = result.post_execution_verification;
    const convergence = result.post_execution_convergence;
    const reverify = result.post_convergence_verification;
    return [
        {
            phase: "plan",
            status: "completed",
            detail: "Goal request and plan contract loaded.",
        },
        {
            phase: "approve",
            status: approved ? "completed" : "blocked",
            detail: approved ? "Scoped approval is present." : "Scoped approval is required before execution.",
            run_id: result.request.approval?.reference,
        },
        {
            phase: "execute",
            status: result.steps.length > 0 ? "completed" : executable ? "blocked" : "skipped",
            detail: result.steps.length > 0
                ? `${result.steps.length} approved step(s) executed.`
                : executable
                    ? "Execution did not produce a completed step."
                    : "Execution skipped until approval is available.",
            artifact_dir: result.artifact_dir,
        },
        {
            phase: "verify",
            status: verification ? "completed" : result.steps.length > 0 ? "blocked" : "skipped",
            detail: verification
                ? `Post-execution verification verdict: ${verification.verdict}.`
                : result.steps.length > 0
                    ? "Post-execution verification was expected but did not run."
                    : "Verification skipped because execution did not run.",
            run_id: verification?.run_id,
            artifact_dir: verification?.artifact_dir,
        },
        {
            phase: "converge",
            status: convergence ? "completed" : verification && verification.verdict !== "sufficient_evidence" ? "skipped" : "skipped",
            detail: convergence
                ? `Post-execution convergence status: ${convergence.status}.`
                : verification && verification.verdict !== "sufficient_evidence"
                    ? "No bounded convergence was run for this verdict."
                    : "Convergence not needed.",
            run_id: convergence?.run_id,
            artifact_dir: convergence?.artifact_dir,
        },
        {
            phase: "reverify",
            status: reverify ? "completed" : convergence ? "blocked" : "skipped",
            detail: reverify
                ? `Post-convergence verification verdict: ${reverify.verdict}.`
                : convergence
                    ? "Post-convergence verification was expected but did not run."
                    : "Re-verification not needed.",
            run_id: reverify?.run_id,
            artifact_dir: reverify?.artifact_dir,
        },
        {
            phase: "report",
            status: "completed",
            detail: "goal-run.json and final.md were written for this lifecycle.",
            artifact_dir: result.artifact_dir,
        },
    ];
}
export function buildGoalLifecycleSummary(result) {
    const userStatus = deriveUserStatus(result);
    return {
        user_status: userStatus,
        terminal_status: result.status,
        current_phase: deriveCurrentPhase(result),
        steps: lifecycleSteps(result),
        next_action: deriveNextAction(userStatus, result),
    };
}
