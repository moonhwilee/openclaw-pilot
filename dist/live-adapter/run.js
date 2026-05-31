import { runRoute } from "../route/run.js";
const maxTelegramTextLength = 3900;
function firstToken(input) {
    return input.trim().split(/\s+/)[0] || "";
}
function truncateTelegramText(text) {
    if (text.length <= maxTelegramTextLength)
        return text;
    return `${text.slice(0, maxTelegramTextLength - 32)}\n... truncated by Pilot adapter`;
}
function bulletLines(values) {
    if (values.length === 0)
        return ["- none"];
    return values.map((value) => `- ${value}`);
}
export function formatRouteForTelegram(route) {
    const report = route.user_report;
    const lines = [
        "Pilot",
        `Status: ${report.status}`,
        `Command: ${route.command}`,
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
    return truncateTelegramText(lines.join("\n"));
}
export async function runLiveAdapter(options) {
    const command = firstToken(options.input);
    const enabled = options.enabledCommands.includes(command);
    const route = await runRoute({ input: options.input, enabled });
    return {
        schema_version: "pilot.live_adapter.v0",
        route,
        telegram_text: formatRouteForTelegram(route),
    };
}
