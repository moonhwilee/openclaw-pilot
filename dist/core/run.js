import { runRoute } from "../route/run.js";
const exactCommands = ["/plan", "/verify", "/conv", "/goal", "approve"];
const exactCommandSet = new Set(exactCommands);
const maxReplyTextLength = 3900;
function firstToken(input) {
    return input.trim().split(/\s+/)[0] || "";
}
function truncateReplyText(text) {
    if (text.length <= maxReplyTextLength)
        return text;
    return `${text.slice(0, maxReplyTextLength - 32)}\n... truncated by Pilot core`;
}
function bulletLines(values) {
    if (values.length === 0)
        return ["- none"];
    return values.map((value) => `- ${value}`);
}
function formatRouteReply(route) {
    const report = route.user_report;
    const runId = typeof route.result_summary?.run_id === "string" ? route.result_summary.run_id : undefined;
    const shortRunId = typeof route.result_summary?.short_run_id === "string" ? route.result_summary.short_run_id : undefined;
    const lifecycle = route.result_summary?.lifecycle &&
        typeof route.result_summary.lifecycle === "object" &&
        !Array.isArray(route.result_summary.lifecycle)
        ? route.result_summary.lifecycle
        : undefined;
    const currentPhase = typeof lifecycle?.current_phase === "string" ? lifecycle.current_phase : undefined;
    const terminalStatus = typeof lifecycle?.terminal_status === "string" ? lifecycle.terminal_status : undefined;
    const lines = [
        "Pilot",
        `Status: ${report.status}`,
        ...(currentPhase ? [`Phase: ${currentPhase}`] : []),
        ...(terminalStatus ? [`Terminal: ${terminalStatus}`] : []),
        `Command: ${route.command}`,
        ...(runId ? [`Run: ${shortRunId || runId}`, ...(shortRunId ? [`Run ID: ${runId}`] : [])] : []),
        "",
        "Evidence",
        ...bulletLines(report.evidence_pointers),
        "",
        "Remaining",
        ...bulletLines(report.remaining_risks),
        "",
        `Next: ${report.next_action}`,
    ];
    if (route.fallback_message) {
        lines.splice(3, 0, `Fallback: ${route.fallback_message}`);
    }
    return truncateReplyText(lines.join("\n"));
}
function safeFailureResult(input, status, errorCode, recoveryHint, metadata) {
    const command = firstToken(input);
    const safeCommand = command || "(empty)";
    const reason = status === "unsupported"
        ? "Unsupported Pilot exact command."
        : "Pilot command failed before a safe route result was produced.";
    const lines = [
        "Pilot",
        `Status: ${status}`,
        `Command: ${safeCommand}`,
        "",
        "Evidence",
        "- none",
        "",
        "Remaining",
        `- ${reason}`,
        "",
        `Next: ${recoveryHint}`,
    ];
    return {
        schema_version: "pilot.command_result.v0",
        status,
        enabled: false,
        command: safeCommand,
        backend: "openclaw-pilot",
        reply_text: truncateReplyText(lines.join("\n")),
        error_code: errorCode,
        recovery_hint: recoveryHint,
        metadata,
    };
}
export async function runPilotCommand(request) {
    const command = firstToken(request.input);
    if (!exactCommandSet.has(command)) {
        return safeFailureResult(request.input, "unsupported", "unsupported_exact_command", `Use one of ${exactCommands.join(", ")}.`, request.metadata);
    }
    const typedCommand = command;
    const enabled = request.enabledCommands?.includes(typedCommand) ||
        (typedCommand === "approve" && (request.enabledCommands?.includes("/plan") || request.enabledCommands?.includes("/goal"))) ||
        false;
    try {
        const route = await runRoute({ input: request.input, enabled, metadata: request.metadata });
        return {
            schema_version: "pilot.command_result.v0",
            status: route.status,
            enabled: route.enabled,
            command: route.command,
            backend: "openclaw-pilot",
            route,
            reply_text: formatRouteReply(route),
            metadata: request.metadata,
        };
    }
    catch {
        return safeFailureResult(request.input, "failed", "pilot_command_failed", "Check the command shape, enabled command list, and required local artifact paths before retrying.", request.metadata);
    }
}
