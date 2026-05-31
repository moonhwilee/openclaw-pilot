import type { RunStatus } from "../types.ts";

export const PHASE1_TERMINAL_STATUSES = new Set<RunStatus>([
  "completed_plan",
  "needs_user_decision",
]);

export function isPhase1TerminalStatus(status: string): status is RunStatus {
  return PHASE1_TERMINAL_STATUSES.has(status as RunStatus);
}
