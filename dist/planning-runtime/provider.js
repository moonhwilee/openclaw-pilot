import { deriveUserFacingPlanDraft } from "./user-facing-plan.js";
export class LocalPlannerProvider {
    draft(input) {
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
export function createDefaultPlannerProvider() {
    return new LocalPlannerProvider();
}
