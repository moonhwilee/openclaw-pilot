import { withExecutionPlanHash } from "../execution-plan.js";
const vagueRequests = new Set(["도와줘", "해줘", "help", "help me", "뭔가 해줘", "알아서 해줘"]);
function requestLooksVague(request) {
    const trimmed = request.trim().toLowerCase();
    return trimmed.length < 12 || vagueRequests.has(trimmed);
}
function requestLooksVagueForMode(request, mode) {
    const trimmed = request.trim().toLowerCase();
    if (vagueRequests.has(trimmed))
        return true;
    if (mode === "verify" || mode === "conv")
        return trimmed.length < 4;
    return requestLooksVague(request);
}
function looksLikeLargeImplementation(request) {
    const normalized = request.toLowerCase();
    return requiresCodexRunner(request) || [
        "large",
        "phase",
        "milestone",
        "architecture",
        "migration",
        "release",
        "runtime",
        "큰",
        "대규모",
        "페이즈",
        "마일스톤",
        "아키텍처",
        "릴리즈",
    ].some((token) => normalized.includes(token));
}
function buildGoalPhasePlan(request, runCodex) {
    if (!looksLikeLargeImplementation(request))
        return [];
    return [
        {
            goal_phase: "goal_phase_1_plan_quality",
            objective: "Improve the user-facing plan before changing execution behavior.",
            slices: [
                {
                    id: "slice_1_outcome_first_plan",
                    objective: "Show the understood outcome, assumptions, scope, non-goals, risks, and verification gates before artifact metadata.",
                    check: [
                        "plan.md contains outcome/context sections before artifact-oriented details",
                        "route reply contains a Plan section before Evidence",
                        "typed execution-plan approval hash remains unchanged",
                    ],
                    convergence_gate: "No P0/P1/P2 issue in user-facing plan clarity or approval boundary.",
                },
            ],
            phase_verify: "Lightweight phase check unless this plan is explicitly promoted to full /verify.",
            pass_criteria: [
                "The user can understand what will be done before approving execution.",
                "No lifecycle phase field is reused for product milestones.",
                "No full semantic /verify is required for this ordinary planning slice.",
            ],
        },
        {
            goal_phase: "goal_phase_2_runtime_milestones",
            objective: "Introduce milestone data only after the user-facing plan contract is stable.",
            slices: [
                {
                    id: "slice_1_model_separation",
                    objective: "Keep lifecycle phases such as execute/verify/converge separate from goal milestones.",
                    check: [
                        "new milestone fields use goal_phase, milestone, or phase_index naming",
                        "existing lifecycle current_phase values remain execute/verify/converge/reverify/report",
                    ],
                    convergence_gate: "No naming collision or stale approval path introduced.",
                },
            ],
            phase_verify: runCodex
                ? "Phase-level semantic verification should classify findings as P0/P1/P2/P3 before continuing."
                : "Phase check can remain deterministic while execution is not performed.",
            pass_criteria: [
                "P0/P1/P2 issues are fixed before the phase passes.",
                "P3 issues are reported and do not accumulate into user-facing quality risk.",
            ],
        },
    ];
}
function normalizeBuildPlanInput(input) {
    if (typeof input === "string")
        return { request: input, mode: "plan" };
    return { request: input.request, mode: input.mode || "plan", anchor: input.anchor };
}
function modeGoal(mode, request) {
    const trimmed = request.trim();
    if (mode === "goal")
        return trimmed;
    if (mode === "verify")
        return `Verify: ${trimmed}`;
    if (mode === "conv")
        return `Converge: ${trimmed}`;
    return trimmed;
}
function modeOutcomeSummary(mode, vague) {
    if (vague)
        return "Pilot needs a sharper target before it can produce an approval-ready plan.";
    if (mode === "verify") {
        return "Pilot will create an approval-ready verification plan; evidence collection and review remain blocked until the typed execution plan is explicitly approved.";
    }
    if (mode === "conv") {
        return "Pilot will create an approval-ready convergence plan; fixes, file edits, and convergence execution remain blocked until the typed execution plan is explicitly approved.";
    }
    if (mode === "goal") {
        return "Pilot will create an approval-ready goal execution plan first; execution remains blocked until the typed execution plan is explicitly approved.";
    }
    return "Pilot will create an approval-ready plan first; execution remains blocked until the typed execution plan is explicitly approved.";
}
function modeContextSummary(mode, phasePlan, anchor) {
    return [
        `Command mode: ${mode}. The explicit command selects the planning mode; Pilot does not re-route natural prose with a keyword fallback.`,
        anchor
            ? `Mechanical anchor: ${anchor.kind} ${anchor.short_reference || anchor.reference}. The anchor narrows context but does not authorize execution.`
            : "No mechanical anchor was required; the natural request is interpreted inside the selected command mode.",
        "The human-readable plan is guidance; the typed execution-plan hash remains the only execution authority.",
        phasePlan.length
            ? "This request looks broad enough to require phase-gated planning and small implementation slices."
            : "This request is small enough to start as a single planning loop unless later context expands the risk.",
    ];
}
function modeScope(mode) {
    if (mode === "verify") {
        return [
            "Create a local verification planning artifact only.",
            "Define evidence scope, review criteria, reviewer boundary, collection plan, and reporting expectations.",
            "Preserve no legacy, no fallback, and no request-prose execution as verification gates.",
        ];
    }
    if (mode === "conv") {
        return [
            "Create a local convergence planning artifact only.",
            "Define the target finding or design gap, expected convergence path, risk boundary, and re-verification gate.",
            "Keep implementation, file edits, and convergence rounds behind explicit approval.",
        ];
    }
    if (mode === "goal") {
        return [
            "Create a local goal execution planning artifact only.",
            "Define goal, scope, success criteria, risks, action boundaries, and verification gates.",
            "Prepare a typed execution plan that can be approved explicitly before any execution.",
        ];
    }
    return [
        "Create a local planning artifact only.",
        "Define goal, scope, success criteria, risks, action boundaries, and verification gates.",
        "Use the document_strategy profile for planning vocabulary and risk defaults.",
    ];
}
function modeOutOfScope(mode) {
    const common = [
        "Mutate files outside the run artifact directory.",
        "Spawn agents.",
        "Send external messages or perform public actions.",
    ];
    if (mode === "verify") {
        return [
            "Collect evidence before approval.",
            "Run reviewers or produce a pass/fail implementation verdict before approval.",
            "Convert natural prose into a deterministic-only evidence packet.",
            ...common,
        ];
    }
    if (mode === "conv") {
        return [
            "Execute convergence rounds before approval.",
            "Bind broad prose to the newest finding as an implicit fallback.",
            "Edit files or claim findings are reduced before approved execution.",
            ...common,
        ];
    }
    return [
        "Execute tools or commands for the user's task.",
        ...common,
        "Route Telegram commands.",
        mode === "goal" ? "Execute the goal before approval." : "Create /goal, /verify, or /conv behavior.",
    ];
}
function modeSuccessCriteria(mode) {
    const common = [
        "A resumable run directory exists.",
        "The four v0 artifacts are present.",
        "The plan satisfies the Common Plan Contract.",
        "Ambiguity is captured when the request is under-specified.",
    ];
    if (mode === "verify") {
        return [
            ...common,
            "The verification plan names concrete evidence classes and review criteria.",
            "No deterministic-only pass or generic run-id dead end is produced for natural verification prose.",
            "No evidence collection or verdict occurs before approval.",
        ];
    }
    if (mode === "conv") {
        return [
            ...common,
            "The convergence plan states whether it is anchored, needs clarification, or should become a goal execution plan.",
            "No convergence round, file edit, or finding reduction occurs before approval.",
        ];
    }
    return [...common, "No execution occurs."];
}
function modeRisks(mode) {
    if (mode === "verify") {
        return [
            "The requested verification may need external evidence, GitHub state, runtime state, or reviewer work after approval.",
            "This plan is not a verdict and must not be presented as implementation proof.",
            "The implementation must reject broad action grants and fallback evidence shortcuts.",
        ];
    }
    if (mode === "conv") {
        return [
            "The convergence target may be under-specified or lack an actionable finding anchor.",
            "This plan is not a fix and must not be presented as reduced findings.",
            "The implementation must reject implicit recent-finding fallback for broad prose.",
        ];
    }
    return [
        "The request may be incomplete and may require a user decision before later execution phases.",
        "This v0 plan is a planning artifact, not approval to execute.",
        "The implementation must reject broad action grants and execution attempts.",
    ];
}
function modeApprovalRequiredActions(mode) {
    if (mode === "verify") {
        return [
            "Collect evidence or inspect external/local project state.",
            "Run semantic reviewers, Codex sessions, tests, smoke checks, or CI checks.",
            "Write a verification verdict, findings report, PR review, release decision, or Gateway/runtime judgment.",
            "Any file mutation outside the run artifact directory.",
            "Any external message, public post, PR, deploy, release, restart, credential, or financial action.",
        ];
    }
    if (mode === "conv") {
        return [
            "Run convergence, edit files, spawn agents, or reduce findings.",
            "Run tests, smoke checks, reviewer loops, or re-verification.",
            "Any file mutation outside the run artifact directory.",
            "Any external message, public post, PR, deploy, release, restart, credential, or financial action.",
        ];
    }
    return [
        "Any future execution beyond local planning.",
        "Any file mutation outside the run artifact directory.",
        "Any external message, public post, PR, deploy, release, restart, credential, or financial action.",
    ];
}
function modeVerificationGates(mode) {
    if (mode === "verify") {
        return [
            "Validate the plan uses command mode verify rather than route keyword fallback.",
            "Validate evidence scope and review criteria are explicit.",
            "Validate no evidence packet fallback, deterministic-only pass, or verdict artifact is produced before approval.",
            "Validate execution-plan hash is required before any evidence collection or reviewer work.",
        ];
    }
    if (mode === "conv") {
        return [
            "Validate the plan uses command mode conv rather than implicit recent-finding fallback.",
            "Validate convergence target, risk boundary, and re-verification gate are explicit.",
            "Validate no natural-conv request, conv result, file edit, or finding reduction is produced before approval.",
            "Validate execution-plan hash is required before convergence execution.",
        ];
    }
    return [
        "Validate goal.json schema fields.",
        "Validate plan.md contains the Common Plan Contract sections.",
        "Validate events.jsonl records lifecycle events.",
        "Validate final.md reports planning-only completion.",
        "Validate no execution artifacts are produced.",
    ];
}
function modeNextStep(mode, vague) {
    if (vague)
        return `Answer the ambiguity questions, then rerun /${mode} with a concrete request.`;
    if (mode === "verify")
        return "Review the verification plan, then approve the plan only if Pilot should collect evidence and run review work.";
    if (mode === "conv")
        return "Review the convergence plan, then approve the plan only if Pilot should execute convergence work.";
    if (mode === "goal")
        return "Review the goal plan, then approve the plan only if Pilot should execute the goal.";
    return "Review the plan artifact before any later phase attempts execution.";
}
function modeDetailedTaskBreakdown(mode) {
    if (mode === "verify") {
        return [
            "Create the run directory.",
            "Write the verification-mode planning artifacts.",
            "Define evidence classes, review criteria, and no-fallback gates.",
            "Stop before evidence collection or verdict generation.",
        ];
    }
    if (mode === "conv") {
        return [
            "Create the run directory.",
            "Write the convergence-mode planning artifacts.",
            "Define target, convergence path, risk boundary, and re-verification gate.",
            "Stop before convergence execution.",
        ];
    }
    return [
        "Create the run directory.",
        "Write the v0 artifacts.",
        "Validate the Common Plan Contract.",
        "Stop without execution.",
    ];
}
export function buildPlan(input) {
    const { request, mode, anchor } = normalizeBuildPlanInput(input);
    const vague = requestLooksVagueForMode(request, mode);
    const codexRunnerLikely = !vague && requiresCodexRunner(request);
    const phasePlan = vague ? [] : buildGoalPhasePlan(request, codexRunnerLikely);
    const ambiguityQuestions = vague
        ? [
            "What concrete outcome should this plan target?",
            "What scope should be included or excluded?",
            "What criteria should decide that the plan is good enough?",
        ]
        : [];
    const status = vague ? "needs_user_decision" : "completed_plan";
    const plan = {
        goal: vague ? `Clarify the requested ${mode} goal before execution.` : modeGoal(mode, request),
        outcome_summary: modeOutcomeSummary(mode, vague),
        context_summary: modeContextSummary(mode, phasePlan, anchor),
        scope: modeScope(mode),
        out_of_scope: modeOutOfScope(mode),
        success_criteria: modeSuccessCriteria(mode),
        risks_assumptions: modeRisks(mode),
        action_boundaries: {
            allowed_actions: ["create_plan_artifact", "record_lifecycle_event"],
            approval_required_actions: modeApprovalRequiredActions(mode),
            disallowed_actions: [
                "execute_user_task",
                "spawn_agent",
                "telegram_routing",
                "shell_escape_as_proof",
            ],
        },
        verification_gates: modeVerificationGates(mode),
        phase_plan: phasePlan,
        ambiguity_questions: ambiguityQuestions,
        next_recommended_step: modeNextStep(mode, vague),
        detailed_task_breakdown: modeDetailedTaskBreakdown(mode),
    };
    return { status, ambiguityQuestions, plan };
}
function buildGoalMilestones(phasePlan) {
    if (!phasePlan?.length)
        return undefined;
    return phasePlan.map((phase, index) => ({
        phase_index: index + 1,
        goal_phase: phase.goal_phase,
        objective: phase.objective,
        slice_ids: phase.slices.map((slice) => slice.id),
        phase_verify: phase.phase_verify,
        pass_criteria: phase.pass_criteria,
        status: "planned",
    }));
}
function selectsPilotReceiptsDashboardStep(request) {
    const normalized = request.toLowerCase();
    return normalized.includes("dashboard") && normalized.includes("receipt");
}
function hasLocalFileReference(request) {
    return /(?:^|\s)(?:\/Users\/\S+|\/tmp\/\S+|\.{1,2}\/\S+|\S+\/\S+\.[A-Za-z0-9]{1,12})(?:\s|$|[.,;:!?")\]])/.test(request);
}
function asksToMutateLocalFile(request) {
    const normalized = request.toLowerCase();
    const mutationTokens = [
        "create",
        "write",
        "save",
        "generate",
        "make",
        "update",
        "modify",
        "edit",
        "append",
        "replace",
        "touch",
        "생성",
        "작성",
        "저장",
        "수정",
        "추가",
        "교체",
    ];
    return hasLocalFileReference(request) && mutationTokens.some((token) => normalized.includes(token));
}
function requiresCodexRunner(request) {
    const normalized = request.toLowerCase();
    return asksToMutateLocalFile(request) || [
        "implement",
        "code",
        "fix",
        "test",
        "refactor",
        "runner",
        "codex",
        "session",
        "구현",
        "수정",
        "테스트",
        "리팩터",
    ].some((token) => normalized.includes(token));
}
export function buildExecutionPlan(request, planRunId, phasePlan, mode = "plan", anchor) {
    if (requestLooksVagueForMode(request, mode))
        return undefined;
    const capability = selectsPilotReceiptsDashboardStep(request)
        ? "create_pilot_receipts_dashboard"
        : mode === "verify" || mode === "conv" || requiresCodexRunner(request)
            ? "run_codex_session"
            : "create_artifact";
    const riskClass = capability === "run_codex_session" ? "high" : "low";
    const scope = capability === "run_codex_session"
        ? [
            `Execute only the concrete work described by plan run ${planRunId}.`,
            "Edit files, run checks, and collect results only within the approved plan boundary.",
            "Stop before any external action, deploy, release, payment, credential access, or destructive filesystem action.",
        ]
        : capability === "create_pilot_receipts_dashboard"
            ? [
                `Create a local Pilot receipts dashboard for plan run ${planRunId}.`,
                "Read local Pilot receipt artifacts as source data.",
                "Write only inside the new goal run artifact directory.",
            ]
            : [
                `Create a bounded local goal artifact for plan run ${planRunId}.`,
                "Write only inside the new goal run artifact directory.",
            ];
    return withExecutionPlanHash({
        schema_version: "pilot.execution_plan.v0",
        plan_run_id: planRunId,
        goal_summary: modeGoal(mode, request),
        goal_milestones: buildGoalMilestones(phasePlan),
        steps: [
            {
                id: "step-1",
                capability,
                risk_class: riskClass,
                scope,
                inputs: {
                    plan_run_id: planRunId,
                    request,
                    plan_mode: mode,
                    ...(anchor ? { anchor } : {}),
                },
                expected_artifacts: capability === "run_codex_session"
                    ? ["runner-prompt.md", "runner-result.json", "runner-stdout.txt", "runner-stderr.txt"]
                    : capability === "create_pilot_receipts_dashboard"
                        ? ["pilot-receipts-dashboard.html"]
                        : ["step-1-goal-artifact.md"],
                verification_gates: capability === "run_codex_session"
                    ? [
                        "runner-result.json exists",
                        "runner exit code is 0",
                        "receipts.jsonl contains pilot.receipt.v0 for run_codex_session",
                    ]
                    : [
                        "expected local artifact exists",
                        `receipts.jsonl contains pilot.receipt.v0 for ${capability}`,
                    ],
                stop_conditions: ["success_criteria_met", "approval_boundary_hit"],
            },
        ],
        forbidden_actions: [
            "external_message",
            "public_post",
            "payment",
            "credential_access",
            "server_restart",
            "deploy",
            "release",
            "pr_merge",
            "destructive_filesystem",
            "out_of_plan_action",
        ],
        requires_reapproval_if: [
            "Execution requires capability not listed in this execution plan.",
            "Execution requires mutating files outside the approved plan boundary.",
            "Execution requires external messages, public posts, payments, credentials, deploys, releases, restarts, or merges.",
            "Execution needs a different risk class, scope, or artifact target than the approved execution plan.",
        ],
    });
}
