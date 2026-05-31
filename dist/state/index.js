export const PHASE1_TERMINAL_STATUSES = new Set([
    "completed_plan",
    "needs_user_decision",
]);
export function isPhase1TerminalStatus(status) {
    return PHASE1_TERMINAL_STATUSES.has(status);
}
