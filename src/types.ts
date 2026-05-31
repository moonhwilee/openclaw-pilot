export type RunStatus = "completed_plan" | "needs_user_decision";

export type ProfileName = "document_strategy" | "research";

export type VerificationVerdict =
  | "sufficient_evidence"
  | "insufficient_evidence"
  | "missing_evidence"
  | "needs_revision"
  | "blocked";

export type RiskClass = "low" | "medium" | "high";

export type ConvStatus =
  | "completed"
  | "max_rounds_reached"
  | "needs_user_decision"
  | "blocked";

export type GoalRunStatus =
  | "awaiting_approval"
  | "completed"
  | "needs_evidence"
  | "needs_revision"
  | "needs_user_decision"
  | "blocked";

export type ActionBoundaries = {
  allowed_actions: string[];
  approval_required_actions: string[];
  disallowed_actions: string[];
};

export type CommonPlanContract = {
  goal: string;
  scope: string[];
  out_of_scope: string[];
  success_criteria: string[];
  risks_assumptions: string[];
  action_boundaries: ActionBoundaries;
  verification_gates: string[];
  ambiguity_questions?: string[];
  next_recommended_step?: string;
  detailed_task_breakdown?: string[];
};

export type GoalArtifact = {
  schema_version: "pilot.goal.v0";
  run_id: string;
  request: string;
  profile: ProfileName;
  status: RunStatus;
  state_root: string;
  artifact_dir: string;
  created_at: string;
  ambiguity_questions: string[];
};

export type PlanResult = {
  run_id: string;
  status: RunStatus;
  artifact_dir: string;
  goal: GoalArtifact;
  plan: CommonPlanContract;
  created_files: string[];
};

export type EventRecord = {
  timestamp: string;
  run_id: string;
  event: string;
  status: string;
  details?: Record<string, unknown>;
};

export type EvidenceItemType = "artifact" | "event" | "source" | "metric" | "note";

export type VerdictCriterion = {
  id: string;
  description: string;
  required: boolean;
};

export type EvidenceItem = {
  id: string;
  type: EvidenceItemType;
  description: string;
  criteria_ids: string[];
  supports_claim: boolean;
  in_scope: boolean;
  path?: string;
  event_ref?: string;
};

export type EvidencePacket = {
  schema_version: "pilot.evidence.v0";
  claim: {
    id: string;
    statement: string;
    profile: ProfileName;
  };
  verdict_criteria: VerdictCriterion[];
  evidence: EvidenceItem[];
  reviewer_boundary: {
    semantic_review_required: boolean;
    deterministic_checks_only: boolean;
  };
};

export type VerificationFinding = {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
};

export type VerificationResult = {
  schema_version: "pilot.verification.v0";
  run_id: string;
  packet: EvidencePacket;
  verdict: VerificationVerdict;
  findings: VerificationFinding[];
  created_at: string;
  artifact_dir: string;
  created_files: string[];
};

export type ConvFindingStatus = "open" | "reduced";

export type ConvFinding = {
  id: string;
  description: string;
  status: ConvFindingStatus;
};

export type ConvPreflight = {
  risk_class: RiskClass;
  allowed_capabilities: string[];
  forbidden_capabilities: string[];
  max_rounds: number;
  stop_condition: "all_findings_reduced" | "max_rounds";
};

export type ConvRequest = {
  schema_version: "pilot.conv_request.v0";
  anchor: {
    id: string;
    path?: string;
    description?: string;
  };
  findings: ConvFinding[];
  preflight: ConvPreflight;
};

export type ConvRound = {
  round: number;
  finding_ids: string[];
  action_summary: string;
  evidence_update: string;
  verdict: "reduced" | "needs_revision" | "blocked";
};

export type TypedReceipt = {
  schema_version: "pilot.receipt.v0";
  action: string;
  capability: string;
  run_id: string;
  round?: number;
  step?: number;
  artifact_path: string;
  status: "ok";
  scope?: string[];
  actor?: string;
  timestamp?: string;
  risk_class?: RiskClass;
  approval_reference?: string;
  primary_proof?: boolean;
};

export type ConvResult = {
  schema_version: "pilot.conv.v0";
  run_id: string;
  status: ConvStatus;
  anchor: ConvRequest["anchor"];
  findings: ConvFinding[];
  rounds: ConvRound[];
  created_at: string;
  artifact_dir: string;
  created_files: string[];
};

export type GoalApproval = {
  reference: string;
  approved: boolean;
  approved_scope: string[];
  approved_capabilities: string[];
};

export type GoalPreflight = {
  risk_class: RiskClass;
  typed_capabilities: string[];
  dangerous_action_gates: string[];
  receipt_required: boolean;
  max_rounds: number;
  stop_conditions: string[];
};

export type GoalRequest = {
  schema_version: "pilot.goal_request.v0";
  goal: {
    id: string;
    statement: string;
    profile: ProfileName;
  };
  plan: CommonPlanContract;
  approval?: GoalApproval;
  preflight: GoalPreflight;
};

export type GoalStep = {
  step: number;
  capability: string;
  action_summary: string;
  artifact_path: string;
  receipt_recorded: boolean;
};

export type GoalRunResult = {
  schema_version: "pilot.goal_run.v0";
  run_id: string;
  status: GoalRunStatus;
  request: GoalRequest;
  steps: GoalStep[];
  findings: VerificationFinding[];
  created_at: string;
  artifact_dir: string;
  created_files: string[];
};

export type RouteStatus = "routed" | "unavailable" | "awaiting_approval" | "needs_user_decision" | "blocked";

export type RouteUserReport = {
  status: string;
  evidence_pointers: string[];
  remaining_risks: string[];
  next_action: string;
};

export type RouteResult = {
  schema_version: "pilot.route.v0";
  status: RouteStatus;
  command: "/plan" | "/verify" | "/conv" | "/goal";
  enabled: boolean;
  fallback_message?: string;
  backend: "openclaw-pilot";
  result_summary?: Record<string, unknown>;
  user_report: RouteUserReport;
};

export type LiveAdapterResult = {
  schema_version: "pilot.live_adapter.v0";
  route: RouteResult;
  telegram_text: string;
};
