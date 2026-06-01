import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
export const executionPlanArtifactName = "execution-plan.json";
export const executionPlanSchemaVersion = "pilot.execution_plan.v0";
function canonicalize(value) {
    if (Array.isArray(value))
        return value.map(canonicalize);
    if (!value || typeof value !== "object")
        return value;
    const record = value;
    return Object.keys(record)
        .sort()
        .reduce((result, key) => {
        if (key === "approval_subject_hash")
            return result;
        result[key] = canonicalize(record[key]);
        return result;
    }, {});
}
export function hashExecutionPlan(plan) {
    const payload = JSON.stringify(canonicalize(plan));
    return createHash("sha256").update(payload).digest("hex");
}
export function withExecutionPlanHash(plan) {
    const draft = { ...plan, approval_subject_hash: "" };
    return { ...draft, approval_subject_hash: hashExecutionPlan(draft) };
}
export async function readExecutionPlan(path) {
    return JSON.parse(await readFile(path, "utf8"));
}
export function executionPlanCapabilities(plan) {
    return [...new Set(plan.steps.map((step) => step.capability))];
}
export function executionPlanScope(plan) {
    return [...new Set(plan.steps.flatMap((step) => step.scope))];
}
export function executionPlanRiskClass(plan) {
    return plan.steps.some((step) => step.risk_class === "high")
        ? "high"
        : plan.steps.some((step) => step.risk_class === "medium")
            ? "medium"
            : "low";
}
export function primaryExecutionStep(plan) {
    return plan.steps[0];
}
