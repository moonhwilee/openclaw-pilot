import { isPhase1TerminalStatus } from "../state/index.js";
import { hashExecutionPlan } from "../execution-plan.js";
import { isSupportedProfile } from "../profiles/index.js";
import { goalCapabilityNames } from "../goal/capabilities.js";
const broadActionGrants = [
    "use tools",
    "fix it",
    "fix issue",
    "fix repo",
    "do whatever is needed",
    "do anything needed",
    "contact people if needed",
    "알아서 해",
];
const lifecyclePhaseNames = new Set(["plan", "approve", "execute", "verify", "converge", "reverify", "report"]);
function isIsoTimestamp(value) {
    return !Number.isNaN(Date.parse(value));
}
export function isBroadActionGrant(value) {
    const normalized = value.trim().toLowerCase();
    return broadActionGrants.some((grant) => normalized.includes(grant));
}
export function validateCommonPlanContract(plan) {
    const errors = [];
    if (!plan.goal.trim())
        errors.push("missing goal");
    if (plan.scope.length === 0)
        errors.push("missing scope");
    if (plan.success_criteria.length === 0)
        errors.push("missing success criteria");
    if (plan.verification_gates.length === 0)
        errors.push("missing verification gates");
    const boundaries = plan.action_boundaries;
    if (boundaries.allowed_actions.length === 0 &&
        boundaries.approval_required_actions.length === 0 &&
        boundaries.disallowed_actions.length === 0) {
        errors.push("missing action boundaries");
    }
    for (const action of boundaries.allowed_actions) {
        if (isBroadActionGrant(action)) {
            errors.push(`overbroad allowed action: ${action}`);
        }
    }
    for (const phase of plan.phase_plan || []) {
        if (!phase.goal_phase?.trim())
            errors.push("missing goal phase");
        if (lifecyclePhaseNames.has(phase.goal_phase)) {
            errors.push(`goal phase must not reuse lifecycle phase name: ${phase.goal_phase}`);
        }
        if (!phase.objective?.trim())
            errors.push(`missing goal phase objective: ${phase.goal_phase || "unknown"}`);
        if (!Array.isArray(phase.slices) || phase.slices.length === 0) {
            errors.push(`missing slices for goal phase: ${phase.goal_phase || "unknown"}`);
        }
        if (!phase.phase_verify?.trim())
            errors.push(`missing phase verify gate: ${phase.goal_phase || "unknown"}`);
        if (!Array.isArray(phase.pass_criteria) || phase.pass_criteria.length === 0) {
            errors.push(`missing phase pass criteria: ${phase.goal_phase || "unknown"}`);
        }
        for (const slice of phase.slices || []) {
            if (!slice.id?.trim())
                errors.push(`missing slice id: ${phase.goal_phase || "unknown"}`);
            if (!slice.objective?.trim())
                errors.push(`missing slice objective: ${slice.id || "unknown"}`);
            if (!Array.isArray(slice.check) || slice.check.length === 0)
                errors.push(`missing slice checks: ${slice.id || "unknown"}`);
            if (!slice.convergence_gate?.trim())
                errors.push(`missing slice convergence gate: ${slice.id || "unknown"}`);
        }
    }
    return errors;
}
export function validateGoalArtifact(goal) {
    const errors = [];
    if (goal.schema_version !== "pilot.goal.v0")
        errors.push("invalid goal schema version");
    if (!goal.run_id.trim())
        errors.push("missing run id");
    if (!goal.request.trim())
        errors.push("missing request");
    if (!isSupportedProfile(goal.profile))
        errors.push("invalid profile");
    if (!isPhase1TerminalStatus(goal.status))
        errors.push(`invalid Phase 1 status: ${goal.status}`);
    if (!goal.state_root.trim())
        errors.push("missing state root");
    if (!goal.artifact_dir.trim())
        errors.push("missing artifact dir");
    if (!isIsoTimestamp(goal.created_at))
        errors.push("invalid created_at timestamp");
    if (!Array.isArray(goal.ambiguity_questions))
        errors.push("invalid ambiguity questions");
    return errors;
}
export function validateEventRecord(event) {
    const errors = [];
    if (!isIsoTimestamp(event.timestamp))
        errors.push("invalid event timestamp");
    if (!event.run_id.trim())
        errors.push("missing event run id");
    if (!event.event.trim())
        errors.push("missing event name");
    if (!event.status.trim())
        errors.push("missing event status");
    return errors;
}
export function validateEvidencePacket(packet) {
    const errors = [];
    if (packet.schema_version !== "pilot.evidence.v0")
        errors.push("invalid evidence schema version");
    if (!packet.claim?.id?.trim())
        errors.push("missing claim id");
    if (!packet.claim?.statement?.trim())
        errors.push("missing claim statement");
    if (!isSupportedProfile(packet.claim?.profile || ""))
        errors.push("invalid claim profile");
    if (!Array.isArray(packet.verdict_criteria) || packet.verdict_criteria.length === 0) {
        errors.push("missing verdict criteria");
    }
    if (!Array.isArray(packet.evidence))
        errors.push("missing evidence list");
    if (!packet.reviewer_boundary)
        errors.push("missing reviewer boundary");
    const criterionIds = new Set();
    for (const criterion of packet.verdict_criteria || []) {
        if (!criterion.id?.trim())
            errors.push("missing criterion id");
        if (!criterion.description?.trim())
            errors.push(`missing criterion description: ${criterion.id || "unknown"}`);
        if (typeof criterion.required !== "boolean")
            errors.push(`invalid criterion required flag: ${criterion.id || "unknown"}`);
        if (criterion.id)
            criterionIds.add(criterion.id);
    }
    for (const item of packet.evidence || []) {
        if (!item.id?.trim())
            errors.push("missing evidence id");
        if (!item.type?.trim())
            errors.push(`missing evidence type: ${item.id || "unknown"}`);
        if (!item.description?.trim())
            errors.push(`missing evidence description: ${item.id || "unknown"}`);
        if (!Array.isArray(item.criteria_ids))
            errors.push(`missing evidence criteria refs: ${item.id || "unknown"}`);
        if (typeof item.supports_claim !== "boolean")
            errors.push(`invalid evidence support flag: ${item.id || "unknown"}`);
        if (typeof item.in_scope !== "boolean")
            errors.push(`invalid evidence scope flag: ${item.id || "unknown"}`);
        if (item.type === "artifact" && !item.path?.trim())
            errors.push(`missing artifact path: ${item.id || "unknown"}`);
        if (item.type === "event" && !item.event_ref?.trim())
            errors.push(`missing event reference: ${item.id || "unknown"}`);
        for (const criterionId of item.criteria_ids || []) {
            if (!criterionIds.has(criterionId)) {
                errors.push(`unknown criterion reference: ${item.id || "unknown"} -> ${criterionId}`);
            }
        }
    }
    if (typeof packet.reviewer_boundary?.semantic_review_required !== "boolean") {
        errors.push("invalid semantic review boundary");
    }
    if (packet.reviewer_boundary?.deterministic_checks_only !== true) {
        errors.push("deterministic_checks_only must be true for local Phase 2 verification");
    }
    return errors;
}
const safeConvCapabilities = new Set([
    "local_artifact_note",
    "finding_status_update",
]);
const safeGoalCapabilities = new Set(goalCapabilityNames);
const dangerousCapabilityHints = [
    "external",
    "deploy",
    "delete",
    "credential",
    "secret",
    "payment",
    "email",
    "public",
    "restart",
    "shell",
    "spawn",
    "telegram",
];
function isDangerousCapability(value) {
    const normalized = value.trim().toLowerCase();
    return dangerousCapabilityHints.some((hint) => normalized.includes(hint));
}
function hasBroadGrant(values) {
    return values.find((value) => isBroadActionGrant(value));
}
export function validateConvRequest(request) {
    const errors = [];
    if (request.schema_version !== "pilot.conv_request.v0")
        errors.push("invalid conv request schema version");
    if (!request.anchor?.id?.trim())
        errors.push("missing anchor id");
    if (!Array.isArray(request.findings) || request.findings.length === 0)
        errors.push("missing findings");
    if (!request.preflight)
        errors.push("missing preflight");
    for (const finding of request.findings || []) {
        if (!finding.id?.trim())
            errors.push("missing finding id");
        if (!finding.description?.trim())
            errors.push(`missing finding description: ${finding.id || "unknown"}`);
        if (finding.status !== "open" && finding.status !== "reduced") {
            errors.push(`invalid finding status: ${finding.id || "unknown"}`);
        }
    }
    const preflight = request.preflight;
    if (!preflight)
        return errors;
    if (!["low", "medium", "high"].includes(preflight.risk_class))
        errors.push("invalid risk class");
    if (!Array.isArray(preflight.allowed_capabilities) || preflight.allowed_capabilities.length === 0) {
        errors.push("missing allowed capabilities");
    }
    if (!Array.isArray(preflight.forbidden_capabilities))
        errors.push("missing forbidden capabilities");
    if (!Number.isInteger(preflight.max_rounds) || preflight.max_rounds < 1)
        errors.push("invalid max rounds");
    if (!["all_findings_reduced", "max_rounds"].includes(preflight.stop_condition))
        errors.push("invalid stop condition");
    for (const capability of preflight.allowed_capabilities || []) {
        if (!safeConvCapabilities.has(capability))
            errors.push(`unsupported conv capability: ${capability}`);
        if (isDangerousCapability(capability))
            errors.push(`dangerous allowed capability: ${capability}`);
    }
    for (const capability of preflight.forbidden_capabilities || []) {
        if (isDangerousCapability(capability))
            continue;
        if ((preflight.allowed_capabilities || []).includes(capability)) {
            errors.push(`capability cannot be both allowed and forbidden: ${capability}`);
        }
    }
    return errors;
}
export function validateExecutionPlan(plan) {
    const errors = [];
    if (plan.schema_version !== "pilot.execution_plan.v0")
        errors.push("invalid execution plan schema version");
    if (!plan.plan_run_id?.trim())
        errors.push("missing execution plan run id");
    if (!plan.approval_subject_hash?.trim())
        errors.push("missing approval subject hash");
    if (!plan.goal_summary?.trim())
        errors.push("missing execution goal summary");
    if (!Array.isArray(plan.steps) || plan.steps.length === 0)
        errors.push("missing execution steps");
    if (!Array.isArray(plan.forbidden_actions))
        errors.push("missing forbidden actions");
    if (!Array.isArray(plan.requires_reapproval_if))
        errors.push("missing reapproval triggers");
    const calculatedHash = hashExecutionPlan(plan);
    if (plan.approval_subject_hash && plan.approval_subject_hash !== calculatedHash) {
        errors.push("execution plan hash mismatch");
    }
    const stepIds = new Set();
    for (const step of plan.steps || []) {
        if (!step.id?.trim())
            errors.push("missing execution step id");
        if (step.id && stepIds.has(step.id))
            errors.push(`duplicate execution step id: ${step.id}`);
        if (step.id)
            stepIds.add(step.id);
        if (!safeGoalCapabilities.has(step.capability))
            errors.push(`unsupported execution capability: ${step.capability || "unknown"}`);
        if (isDangerousCapability(step.capability || ""))
            errors.push(`dangerous execution capability: ${step.capability || "unknown"}`);
        if (!["low", "medium", "high"].includes(step.risk_class))
            errors.push(`invalid execution risk class: ${step.id || "unknown"}`);
        if (!Array.isArray(step.scope) || step.scope.length === 0)
            errors.push(`missing execution scope: ${step.id || "unknown"}`);
        if (!step.inputs || typeof step.inputs !== "object" || Array.isArray(step.inputs)) {
            errors.push(`invalid execution inputs: ${step.id || "unknown"}`);
        }
        if (!Array.isArray(step.expected_artifacts) || step.expected_artifacts.length === 0) {
            errors.push(`missing expected artifacts: ${step.id || "unknown"}`);
        }
        if (!Array.isArray(step.verification_gates) || step.verification_gates.length === 0) {
            errors.push(`missing verification gates: ${step.id || "unknown"}`);
        }
        if (!Array.isArray(step.stop_conditions) || step.stop_conditions.length === 0) {
            errors.push(`missing stop conditions: ${step.id || "unknown"}`);
        }
        const broadScope = hasBroadGrant(step.scope || []);
        if (broadScope)
            errors.push(`overbroad execution scope: ${broadScope}`);
    }
    for (const action of plan.forbidden_actions || []) {
        if (isBroadActionGrant(action))
            errors.push(`overbroad forbidden action: ${action}`);
    }
    for (const trigger of plan.requires_reapproval_if || []) {
        if (isBroadActionGrant(trigger))
            errors.push(`overbroad reapproval trigger: ${trigger}`);
    }
    return errors;
}
export function validateGoalRequest(request) {
    const errors = [];
    if (request.schema_version !== "pilot.goal_request.v0")
        errors.push("invalid goal request schema version");
    if (!request.goal?.id?.trim())
        errors.push("missing goal id");
    if (!request.goal?.statement?.trim())
        errors.push("missing goal statement");
    if (!isSupportedProfile(request.goal?.profile || ""))
        errors.push("invalid goal profile");
    if (!request.plan)
        errors.push("missing plan");
    if (!request.preflight)
        errors.push("missing preflight");
    if (request.plan) {
        errors.push(...validateCommonPlanContract(request.plan));
        const broadApproval = hasBroadGrant(request.plan.action_boundaries.approval_required_actions);
        if (broadApproval)
            errors.push(`overbroad approval boundary: ${broadApproval}`);
    }
    const executionPlan = request.execution_plan;
    if (executionPlan) {
        errors.push(...validateExecutionPlan(executionPlan));
        if (executionPlan.plan_run_id !== request.approval?.reference && request.approval?.approved) {
            errors.push("execution plan run id does not match approval reference");
        }
    }
    const preflight = request.preflight;
    if (!preflight)
        return errors;
    if (!["low", "medium", "high"].includes(preflight.risk_class))
        errors.push("invalid risk class");
    if (!Array.isArray(preflight.typed_capabilities) || preflight.typed_capabilities.length === 0) {
        errors.push("missing typed capabilities");
    }
    if (!Array.isArray(preflight.dangerous_action_gates))
        errors.push("missing dangerous action gates");
    if (preflight.receipt_required !== true)
        errors.push("receipt requirement must be true for executable goals");
    if (!Number.isInteger(preflight.max_rounds) || preflight.max_rounds < 1)
        errors.push("invalid max rounds");
    if (!Array.isArray(preflight.stop_conditions) || preflight.stop_conditions.length === 0) {
        errors.push("missing stop conditions");
    }
    for (const capability of preflight.typed_capabilities || []) {
        if (!safeGoalCapabilities.has(capability))
            errors.push(`unsupported goal capability: ${capability}`);
        if (isDangerousCapability(capability))
            errors.push(`dangerous goal capability: ${capability}`);
        if (isBroadActionGrant(capability))
            errors.push(`overbroad goal capability: ${capability}`);
    }
    for (const gate of preflight.dangerous_action_gates || []) {
        if (isBroadActionGrant(gate))
            errors.push(`overbroad dangerous action gate: ${gate}`);
    }
    const approval = request.approval;
    if (!approval)
        return errors;
    if (!executionPlan)
        errors.push("approved goal requires execution plan");
    if (!approval.execution_plan_ref?.trim())
        errors.push("missing approved execution plan ref");
    if (!approval.execution_plan_hash?.trim())
        errors.push("missing approved execution plan hash");
    if (executionPlan && approval.execution_plan_hash && approval.execution_plan_hash !== executionPlan.approval_subject_hash) {
        errors.push("approved execution plan hash mismatch");
    }
    if (!approval.reference?.trim())
        errors.push("missing approval reference");
    if (typeof approval.approved !== "boolean")
        errors.push("invalid approval flag");
    if (!Array.isArray(approval.approved_scope) || approval.approved_scope.length === 0)
        errors.push("missing approved scope");
    if (!Array.isArray(approval.approved_capabilities) || approval.approved_capabilities.length === 0) {
        errors.push("missing approved capabilities");
    }
    const broadApprovedScope = hasBroadGrant(approval.approved_scope || []);
    if (broadApprovedScope)
        errors.push(`overbroad approved scope: ${broadApprovedScope}`);
    const broadApprovedCapability = hasBroadGrant(approval.approved_capabilities || []);
    if (broadApprovedCapability)
        errors.push(`overbroad approved capability: ${broadApprovedCapability}`);
    for (const capability of approval.approved_capabilities || []) {
        if (executionPlan && !executionPlan.steps.some((step) => step.capability === capability)) {
            errors.push(`approved capability is outside execution plan: ${capability}`);
        }
        if (isDangerousCapability(capability))
            errors.push(`dangerous approved capability: ${capability}`);
    }
    return errors;
}
