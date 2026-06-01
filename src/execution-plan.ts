import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ExecutionPlan, ExecutionStep, RiskClass } from "./types.ts";

export const executionPlanArtifactName = "execution-plan.json";
export const executionPlanSchemaVersion = "pilot.execution_plan.v0" as const;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.keys(record)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      if (key === "approval_subject_hash") return result;
      result[key] = canonicalize(record[key]);
      return result;
    }, {});
}

export function hashExecutionPlan(plan: ExecutionPlan): string {
  const payload = JSON.stringify(canonicalize(plan));
  return createHash("sha256").update(payload).digest("hex");
}

export function withExecutionPlanHash(plan: Omit<ExecutionPlan, "approval_subject_hash">): ExecutionPlan {
  const draft: ExecutionPlan = { ...plan, approval_subject_hash: "" };
  return { ...draft, approval_subject_hash: hashExecutionPlan(draft) };
}

export async function readExecutionPlan(path: string): Promise<ExecutionPlan> {
  return JSON.parse(await readFile(path, "utf8")) as ExecutionPlan;
}

export function executionPlanCapabilities(plan: ExecutionPlan): string[] {
  return [...new Set(plan.steps.map((step) => step.capability))];
}

export function executionPlanScope(plan: ExecutionPlan): string[] {
  return [...new Set(plan.steps.flatMap((step) => step.scope))];
}

export function executionPlanRiskClass(plan: ExecutionPlan): RiskClass {
  return plan.steps.some((step) => step.risk_class === "high")
    ? "high"
    : plan.steps.some((step) => step.risk_class === "medium")
      ? "medium"
      : "low";
}

export function primaryExecutionStep(plan: ExecutionPlan): ExecutionStep | undefined {
  return plan.steps[0];
}
