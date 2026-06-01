import type { CommandPlanAnchor } from "../plan/generate.ts";
import type { CommonPlanContract, ExecutionPlan, PlanMode, UserFacingPlanDraft } from "../types.ts";
import { deriveUserFacingPlanDraft } from "./user-facing-plan.ts";

export type PlannerProviderInput = {
  mode: PlanMode;
  request: string;
  plan: CommonPlanContract;
  anchor?: CommandPlanAnchor;
  executionPlan?: ExecutionPlan;
};

export type PlannerProviderResult =
  | {
      status: "draft_ready";
      draft: UserFacingPlanDraft;
    }
  | {
      status: "needs_clarification";
      draft: UserFacingPlanDraft;
      questions: string[];
    };

export interface PlannerProvider {
  draft(input: PlannerProviderInput): PlannerProviderResult;
}

export class LocalPlannerProvider implements PlannerProvider {
  draft(input: PlannerProviderInput): PlannerProviderResult {
    const draft = deriveUserFacingPlanDraft(input);
    if (draft.open_questions?.length) {
      return {
        status: "needs_clarification",
        draft,
        questions: draft.open_questions,
      };
    }
    return {
      status: "draft_ready",
      draft,
    };
  }
}

export function createDefaultPlannerProvider(): PlannerProvider {
  return new LocalPlannerProvider();
}
