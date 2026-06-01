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

export type GoalLifecyclePhase =
  | "plan"
  | "approve"
  | "execute"
  | "verify"
  | "converge"
  | "reverify"
  | "report";

export type GoalLifecycleStepStatus = "completed" | "skipped" | "blocked";

export type GoalUserStatus =
  | "awaiting_approval"
  | "completed_verified"
  | "completed_after_convergence"
  | "completed_with_risks"
  | "needs_evidence"
  | "needs_revision"
  | "needs_user_decision"
  | "blocked";

export type GoalLifecycleStep = {
  phase: GoalLifecyclePhase;
  status: GoalLifecycleStepStatus;
  detail: string;
  run_id?: string;
  artifact_dir?: string;
};

export type GoalLifecycleSummary = {
  user_status: GoalUserStatus;
  terminal_status: GoalRunStatus;
  current_phase: GoalLifecyclePhase;
  steps: GoalLifecycleStep[];
  next_action: string;
};

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
  supporting_artifacts?: string[];
  receipt_recorded: boolean;
};

export type GoalRunResult = {
  schema_version: "pilot.goal_run.v0";
  run_id: string;
  status: GoalRunStatus;
  request: GoalRequest;
  steps: GoalStep[];
  findings: VerificationFinding[];
  lifecycle?: GoalLifecycleSummary;
  post_execution_verification?: {
    run_id: string;
    verdict: VerificationVerdict;
    artifact_dir: string;
    evidence_packet_path: string;
  };
  post_execution_convergence?: {
    run_id: string;
    status: ConvStatus;
    artifact_dir: string;
    request_path: string;
    rounds: number;
  };
  post_convergence_verification?: {
    run_id: string;
    verdict: VerificationVerdict;
    artifact_dir: string;
    evidence_packet_path: string;
  };
  created_at: string;
  artifact_dir: string;
  created_files: string[];
};

export type RouteStatus =
  | "routed"
  | "approval_target_confirmed"
  | "unavailable"
  | "awaiting_approval"
  | "needs_user_decision"
  | "blocked";

export type RouteCommand = "/plan" | "/verify" | "/conv" | "/goal" | "approve";

export type RouteUserReport = {
  status: string;
  evidence_pointers: string[];
  remaining_risks: string[];
  next_action: string;
};

export type PilotRunIndexEntry = {
  schema_version: "pilot.run_index.v0";
  created_at: string;
  channel: string;
  chat_id?: string;
  sender_id?: string;
  source_message_id?: string;
  source_update_id?: string;
  command: RouteResult["command"];
  run_id: string;
  short_run_id: string;
  status: string;
  artifact_dir: string;
  next_action: string;
};

export type PilotApprovalEntry = {
  schema_version: "pilot.approval.v0";
  created_at: string;
  channel: string;
  chat_id?: string;
  sender_id?: string;
  source_message_id?: string;
  source_update_id?: string;
  reference: string;
  run_id: string;
  short_run_id: string;
  artifact_dir: string;
  status: "approved";
  approved_scope: string[];
  approved_capabilities: string[];
  next_action: string;
};

export type PilotLineageRecord = {
  schema_version: "pilot.lineage.v0";
  created_at: string;
  record_type: "run" | "approval";
  command: RouteCommand;
  run_id: string;
  short_run_id: string;
  status: string;
  state_root: string;
  artifact_dir: string;
  parent_run_id?: string;
  approval_reference?: string;
  evidence_pointers: string[];
  receipt_pointers?: string[];
  resume_hint: string;
  metadata?: Record<string, string>;
};

export type RouteResult = {
  schema_version: "pilot.route.v0";
  status: RouteStatus;
  command: RouteCommand;
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

export type GatewayBridgeResult = {
  schema_version: "pilot.gateway_bridge.v0";
  status: RouteStatus | "unsupported" | "unauthorized" | "failed" | "timeout";
  live_routing_enabled: boolean;
  enabled_commands: RouteResult["command"][];
  route?: RouteResult;
  telegram_text: string;
  duration_ms: number;
  error_code?: string;
};
