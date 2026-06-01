#!/usr/bin/env node
import { runConv } from "./conv/run.js";
import { runDoctor } from "./doctor/run.js";
import { runGoal } from "./goal/run.js";
import { runInit } from "./init/run.js";
import { runLiveAdapter } from "./live-adapter/run.js";
import { runPlan } from "./plan/run.js";
import { runRoute } from "./route/run.js";
import { runSmoke } from "./smoke/run.js";
import { runVerify } from "./verify/run.js";
function usage() {
    return [
        "Usage:",
        "  pilot init [--force]",
        "  pilot doctor [--strict]",
        "  pilot smoke",
        '  pilot plan "<request>"',
        "  pilot verify <evidence-packet.json>",
        "  pilot conv <conv-request.json>",
        "  pilot goal <goal-request.json>",
        "  pilot list [limit]",
        "  pilot status <Run>",
        "  pilot resume <Run>",
        "  pilot cancel <Run> [reason]",
        '  pilot route --enabled|--disabled "<exact command>"',
        '  pilot live --enabled=/plan,/verify "<exact command>"',
        "",
        "Current local Pilot supports easy package init plus plan, verify, anchored conv, and scoped goal.",
    ].join("\n");
}
async function main(argv) {
    const [command, ...rest] = argv;
    if (!command || command === "-h" || command === "--help") {
        console.log(usage());
        return command ? 0 : 1;
    }
    if (command === "init") {
        const force = rest.includes("--force");
        const result = await runInit({ force });
        console.log(JSON.stringify(result, null, 2));
        return 0;
    }
    if (command === "doctor") {
        const strict = rest.includes("--strict");
        const result = await runDoctor({ strict });
        console.log(JSON.stringify(result, null, 2));
        return result.status === "error" ? 1 : 0;
    }
    if (command === "smoke") {
        const result = await runSmoke();
        console.log(JSON.stringify(result, null, 2));
        return result.status === "ok" ? 0 : 1;
    }
    if (command === "verify") {
        const packetPath = rest.join(" ").trim();
        if (!packetPath) {
            console.error("pilot verify requires an evidence packet JSON path");
            return 1;
        }
        const result = await runVerify({ packetPath });
        console.log(JSON.stringify({
            verdict: result.verdict,
            run_id: result.run_id,
            artifact_dir: result.artifact_dir,
            created_files: result.created_files,
            findings: result.findings,
        }, null, 2));
        return 0;
    }
    if (command === "conv") {
        const requestPath = rest.join(" ").trim();
        if (!requestPath) {
            console.error("pilot conv requires a conv request JSON path");
            return 1;
        }
        const result = await runConv({ requestPath });
        console.log(JSON.stringify({
            status: result.status,
            run_id: result.run_id,
            artifact_dir: result.artifact_dir,
            created_files: result.created_files,
            findings: result.findings,
            rounds: result.rounds,
        }, null, 2));
        return 0;
    }
    if (command === "goal") {
        const requestPath = rest.join(" ").trim();
        if (!requestPath) {
            console.error("pilot goal requires a goal request JSON path");
            return 1;
        }
        const result = await runGoal({ requestPath });
        console.log(JSON.stringify({
            status: result.status,
            run_id: result.run_id,
            artifact_dir: result.artifact_dir,
            created_files: result.created_files,
            findings: result.findings,
            steps: result.steps,
        }, null, 2));
        return 0;
    }
    if (command === "list") {
        const input = `list ${rest.join(" ").trim()}`.trim();
        const result = await runRoute({ input, enabled: true });
        console.log(JSON.stringify(result, null, 2));
        return 0;
    }
    if (command === "status") {
        const reference = rest.join(" ").trim();
        if (!reference) {
            console.error("pilot status requires a run reference");
            return 1;
        }
        const result = await runRoute({ input: `status ${reference}`, enabled: true });
        console.log(JSON.stringify(result, null, 2));
        return result.status === "needs_user_decision" ? 1 : 0;
    }
    if (command === "resume") {
        const reference = rest.join(" ").trim();
        if (!reference) {
            console.error("pilot resume requires a run reference");
            return 1;
        }
        const result = await runRoute({ input: `resume ${reference}`, enabled: true });
        console.log(JSON.stringify(result, null, 2));
        return result.status === "needs_user_decision" || result.status === "blocked" ? 1 : 0;
    }
    if (command === "cancel") {
        const referenceAndReason = rest.join(" ").trim();
        if (!referenceAndReason) {
            console.error("pilot cancel requires a run reference");
            return 1;
        }
        const result = await runRoute({ input: `cancel ${referenceAndReason}`, enabled: true });
        console.log(JSON.stringify(result, null, 2));
        return result.status === "needs_user_decision" || result.status === "blocked" ? 1 : 0;
    }
    if (command === "route") {
        const [flag, ...routeParts] = rest;
        if (flag !== "--enabled" && flag !== "--disabled") {
            console.error("pilot route requires --enabled or --disabled");
            return 1;
        }
        const input = routeParts.join(" ").trim();
        if (!input) {
            console.error("pilot route requires an exact command string");
            return 1;
        }
        const result = await runRoute({ input, enabled: flag === "--enabled" });
        console.log(JSON.stringify(result, null, 2));
        return 0;
    }
    if (command === "live") {
        const [flag, ...liveParts] = rest;
        if (!flag?.startsWith("--enabled=")) {
            console.error("pilot live requires --enabled=/plan,/verify,/conv,/goal");
            return 1;
        }
        const enabledCommands = flag
            .slice("--enabled=".length)
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);
        const input = liveParts.join(" ").trim();
        if (!input) {
            console.error("pilot live requires an exact command string");
            return 1;
        }
        const result = await runLiveAdapter({ input, enabledCommands });
        console.log(JSON.stringify(result, null, 2));
        return 0;
    }
    if (command !== "plan") {
        console.error(`unknown pilot command: ${command}`);
        console.error(usage());
        return 1;
    }
    const request = rest.join(" ").trim();
    if (!request) {
        console.error("pilot plan requires a request");
        return 1;
    }
    const result = await runPlan({ request });
    console.log(JSON.stringify({
        status: result.status,
        run_id: result.run_id,
        artifact_dir: result.artifact_dir,
        created_files: result.created_files,
    }, null, 2));
    return 0;
}
main(process.argv.slice(2))
    .then((code) => {
    process.exitCode = code;
})
    .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
});
