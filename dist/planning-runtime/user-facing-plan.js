function modeTitle(mode) {
    if (mode === "goal")
        return "Goal Plan";
    if (mode === "verify")
        return "Verification Plan";
    if (mode === "conv")
        return "Convergence Plan";
    return "Planning Draft";
}
function compact(values, fallback) {
    const clean = (values || []).map((value) => value.trim()).filter(Boolean);
    return clean.length ? clean : fallback;
}
function userFacingStep(value) {
    return value
        .replace(/Write the v0 artifacts\./g, "Prepare the planning record.")
        .replace(/Write the verification-mode planning artifacts\./g, "Prepare the verification planning record.")
        .replace(/Write the convergence-mode planning artifacts\./g, "Prepare the convergence planning record.")
        .replace(/Validate the Common Plan Contract\./g, "Check that the plan is internally consistent.")
        .replace(/Create the run directory\./g, "Create a resumable planning run.")
        .replace(/Stop without execution\./g, "Stop before execution.")
        .replace(/Stop before evidence collection or verdict generation\./g, "Stop before collecting evidence or producing a verdict.")
        .replace(/Stop before convergence execution\./g, "Stop before executing convergence work.");
}
function phaseApproach(plan) {
    if (!plan.phase_plan?.length)
        return compact(plan.scope, ["Clarify the requested outcome and keep execution separate from planning."]);
    return plan.phase_plan.map((phase) => `${phase.objective} Check: ${phase.phase_verify}`);
}
function phaseSteps(plan) {
    const phaseSlices = (plan.phase_plan || []).flatMap((phase) => phase.slices.map((slice) => `${slice.objective} Gate: ${slice.convergence_gate}`));
    return compact(phaseSlices.length ? phaseSlices : plan.detailed_task_breakdown, [
        "Create the planning artifacts.",
        "Review the plan before any execution step.",
        "Keep execution blocked until the correct approval path is used.",
    ]).map(userFacingStep);
}
function notDoingYet(mode, plan) {
    const common = compact(plan.out_of_scope, ["No execution has been performed yet."]).filter((item) => !/route telegram commands/i.test(item));
    if (mode === "plan")
        return ["This is planning-only output, not execution approval.", ...common];
    return ["No execution has been performed yet.", "No evidence or verdict has been produced yet.", ...common];
}
function approvalBoundary(mode, plan, executionPlan) {
    if (mode === "plan") {
        return [
            "This command creates a planning draft only.",
            "Use /goal, /verify, or /conv when the work should become an approval-backed execution workflow.",
        ];
    }
    const executionScope = executionPlan?.steps.flatMap((step) => step.scope).slice(0, 3) || [];
    return compact([
        ...plan.action_boundaries.approval_required_actions.slice(0, 4),
        ...executionScope.map((scope) => `Approved execution scope: ${scope}`),
    ], ["Execution requires explicit approval of the typed execution plan."]);
}
function anchorAssumption(anchor) {
    if (!anchor)
        return [];
    return [`Anchored to ${anchor.kind} ${anchor.short_reference || anchor.reference}; this narrows context but does not authorize execution.`];
}
function verificationPlan(mode, plan) {
    const hashGate = "Before execution, recompute and validate the current typed execution plan hash.";
    if (mode === "verify") {
        return [
            "Confirm the evidence scope and review criteria are explicit.",
            "Confirm no evidence collection or verdict is reported before approval.",
            hashGate,
        ];
    }
    if (mode === "conv") {
        return [
            "Confirm the convergence target and re-verification gate are explicit.",
            "Confirm no fixes, file edits, or finding reductions happen before approval.",
            hashGate,
        ];
    }
    if (mode === "goal") {
        return [
            "Confirm the goal, scope, and success criteria are understandable.",
            "Confirm execution remains blocked until approval.",
            hashGate,
        ];
    }
    return [
        "Confirm the draft is understandable before any execution workflow starts.",
        "Confirm this /plan output is not presented as execution approval.",
        ...plan.success_criteria.slice(0, 2).map((criterion) => `Planning criterion: ${criterion}`),
    ];
}
export function deriveUserFacingPlanDraft(input) {
    const { mode, request, plan, anchor, executionPlan } = input;
    return {
        title: modeTitle(mode),
        mode,
        understood_request: plan.outcome_summary || plan.goal || request,
        assumptions: compact([...anchorAssumption(anchor), ...plan.risks_assumptions.slice(0, 3)], [
            "The request should be handled through an explicit planning and approval flow.",
        ]),
        approach: phaseApproach(plan).slice(0, 4),
        steps: phaseSteps(plan).slice(0, 5),
        verification: verificationPlan(mode, plan).slice(0, 5),
        approval_boundary: approvalBoundary(mode, plan, executionPlan).slice(0, 6),
        not_doing_yet: notDoingYet(mode, plan).slice(0, 6),
        ...(plan.ambiguity_questions?.length ? { open_questions: plan.ambiguity_questions } : {}),
    };
}
