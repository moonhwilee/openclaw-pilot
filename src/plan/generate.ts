import { withExecutionPlanHash } from "../execution-plan.ts";
import type { CommonPlanContract, ExecutionPlan, GoalMilestone, GoalPhasePlan, RunStatus } from "../types.ts";

const vagueRequests = new Set(["도와줘", "해줘", "help", "help me", "뭔가 해줘", "알아서 해줘"]);

function requestLooksVague(request: string): boolean {
  const trimmed = request.trim().toLowerCase();
  return trimmed.length < 12 || vagueRequests.has(trimmed);
}

function looksLikeLargeImplementation(request: string): boolean {
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

function buildGoalPhasePlan(request: string, runCodex: boolean): GoalPhasePlan[] {
  if (!looksLikeLargeImplementation(request)) return [];

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

export function buildPlan(request: string): { status: RunStatus; ambiguityQuestions: string[]; plan: CommonPlanContract } {
  const vague = requestLooksVague(request);
  const codexRunnerLikely = !vague && requiresCodexRunner(request);
  const phasePlan = vague ? [] : buildGoalPhasePlan(request, codexRunnerLikely);
  const ambiguityQuestions = vague
    ? [
        "What concrete outcome should this plan target?",
        "What scope should be included or excluded?",
        "What criteria should decide that the plan is good enough?",
      ]
    : [];

  const status: RunStatus = vague ? "needs_user_decision" : "completed_plan";

  const plan: CommonPlanContract = {
    goal: vague ? "Clarify the requested planning goal before execution." : request.trim(),
    outcome_summary: vague
      ? "Pilot needs a sharper target before it can produce an approval-ready plan."
      : "Pilot will create an approval-ready plan first; execution remains blocked until the typed execution plan is explicitly approved.",
    context_summary: [
      "Pilot has only the user request and local Pilot planning contract at this stage.",
      "The human-readable plan is guidance; the typed execution-plan hash remains the only execution authority.",
      phasePlan.length
        ? "This request looks broad enough to require phase-gated planning and small implementation slices."
        : "This request is small enough to start as a single planning loop unless later context expands the risk.",
    ],
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
    phase_plan: phasePlan,
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

function buildGoalMilestones(phasePlan: GoalPhasePlan[] | undefined): GoalMilestone[] | undefined {
  if (!phasePlan?.length) return undefined;

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

function selectsPilotReceiptsDashboardStep(request: string): boolean {
  const normalized = request.toLowerCase();
  return normalized.includes("dashboard") && normalized.includes("receipt");
}

function hasLocalFileReference(request: string): boolean {
  return /(?:^|\s)(?:\/Users\/\S+|\/tmp\/\S+|\.{1,2}\/\S+|\S+\/\S+\.[A-Za-z0-9]{1,12})(?:\s|$|[.,;:!?")\]])/.test(
    request,
  );
}

function asksToMutateLocalFile(request: string): boolean {
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

function requiresCodexRunner(request: string): boolean {
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

export function buildExecutionPlan(
  request: string,
  planRunId: string,
  phasePlan?: GoalPhasePlan[],
): ExecutionPlan | undefined {
  if (requestLooksVague(request)) return undefined;

  const capability = selectsPilotReceiptsDashboardStep(request)
    ? "create_pilot_receipts_dashboard"
    : requiresCodexRunner(request)
      ? "run_codex_session"
      : "create_artifact";
  const riskClass = capability === "run_codex_session" ? "high" : "low";
  const scope =
    capability === "run_codex_session"
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
    goal_summary: request.trim(),
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
        },
        expected_artifacts:
          capability === "run_codex_session"
            ? ["runner-prompt.md", "runner-result.json", "runner-stdout.txt", "runner-stderr.txt"]
            : capability === "create_pilot_receipts_dashboard"
              ? ["pilot-receipts-dashboard.html"]
              : ["step-1-goal-artifact.md"],
        verification_gates:
          capability === "run_codex_session"
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
