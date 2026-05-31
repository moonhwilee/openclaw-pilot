const vagueRequests = new Set(["도와줘", "해줘", "help", "help me", "뭔가 해줘", "알아서 해줘"]);
function requestLooksVague(request) {
    const trimmed = request.trim().toLowerCase();
    return trimmed.length < 12 || vagueRequests.has(trimmed);
}
export function buildPlan(request) {
    const vague = requestLooksVague(request);
    const ambiguityQuestions = vague
        ? [
            "What concrete outcome should this plan target?",
            "What scope should be included or excluded?",
            "What criteria should decide that the plan is good enough?",
        ]
        : [];
    const status = vague ? "needs_user_decision" : "completed_plan";
    const plan = {
        goal: vague ? "Clarify the requested planning goal before execution." : request.trim(),
        scope: [
            "Create a local planning artifact only.",
            "Define goal, scope, success criteria, risks, action boundaries, and verification gates.",
            "Use the document_strategy profile for planning vocabulary and risk defaults.",
        ],
        out_of_scope: [
            "Execute tools or commands for the user's task.",
            "Mutate files outside the run artifact directory.",
            "Spawn agents.",
            "Route Telegram commands.",
            "Create /goal, /verify, or /conv behavior.",
            "Send external messages or perform public actions.",
        ],
        success_criteria: [
            "A resumable run directory exists.",
            "The four v0 artifacts are present.",
            "The plan satisfies the Common Plan Contract.",
            "Ambiguity is captured when the request is under-specified.",
            "No execution occurs.",
        ],
        risks_assumptions: [
            "The request may be incomplete and may require a user decision before later execution phases.",
            "This v0 plan is a planning artifact, not approval to execute.",
            "The implementation must reject broad action grants and execution attempts.",
        ],
        action_boundaries: {
            allowed_actions: ["create_plan_artifact", "record_lifecycle_event"],
            approval_required_actions: [
                "Any future execution beyond local planning.",
                "Any file mutation outside the run artifact directory.",
                "Any external message, public post, PR, deploy, release, restart, credential, or financial action.",
            ],
            disallowed_actions: [
                "execute_user_task",
                "spawn_agent",
                "telegram_routing",
                "shell_escape_as_proof",
            ],
        },
        verification_gates: [
            "Validate goal.json schema fields.",
            "Validate plan.md contains the Common Plan Contract sections.",
            "Validate events.jsonl records lifecycle events.",
            "Validate final.md reports planning-only completion.",
            "Validate no execution artifacts are produced.",
        ],
        ambiguity_questions: ambiguityQuestions,
        next_recommended_step: vague
            ? "Answer the ambiguity questions, then rerun pilot plan with a concrete request."
            : "Review the plan artifact before any later phase attempts execution.",
        detailed_task_breakdown: [
            "Create the run directory.",
            "Write the v0 artifacts.",
            "Validate the Common Plan Contract.",
            "Stop without execution.",
        ],
    };
    return { status, ambiguityQuestions, plan };
}
