import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runConv } from "../conv/run.js";
import { runGoal } from "../goal/run.js";
import { runLiveAdapter } from "../live-adapter/run.js";
import { runPlan } from "../plan/run.js";
import { runRoute } from "../route/run.js";
import { runVerify } from "../verify/run.js";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
async function check(name, fn) {
    try {
        await fn();
        return { name, status: "ok", message: "passed" };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { name, status: "error", message };
    }
}
export async function runSmoke() {
    const stateRoot = await mkdtemp(join(tmpdir(), "pilot-smoke-"));
    const fixture = (path) => resolve(packageRoot, path);
    const checks = await Promise.all([
        check("plan", async () => {
            const result = await runPlan({ request: "Draft a local document strategy plan.", stateRoot });
            if (result.status !== "completed_plan")
                throw new Error(`unexpected status: ${result.status}`);
        }),
        check("verify", async () => {
            const result = await runVerify({
                packetPath: fixture("fixtures/document_strategy/evidence-packet.json"),
                stateRoot,
            });
            if (result.verdict !== "sufficient_evidence")
                throw new Error(`unexpected verdict: ${result.verdict}`);
        }),
        check("conv", async () => {
            const result = await runConv({
                requestPath: fixture("fixtures/document_strategy/conv-request.json"),
                stateRoot,
            });
            if (result.status !== "completed")
                throw new Error(`unexpected status: ${result.status}`);
        }),
        check("goal_draft", async () => {
            const result = await runGoal({
                requestPath: fixture("fixtures/document_strategy/goal-request-draft.json"),
                stateRoot,
            });
            if (result.status !== "awaiting_approval")
                throw new Error(`unexpected status: ${result.status}`);
        }),
        check("route_disabled", async () => {
            const result = await runRoute({ input: "/plan Draft a local document strategy plan.", enabled: false });
            if (result.status !== "unavailable")
                throw new Error(`unexpected status: ${result.status}`);
        }),
        check("live_adapter", async () => {
            const result = await runLiveAdapter({
                input: "/plan Draft a local document strategy plan.",
                enabledCommands: ["/plan"],
            });
            if (result.route.status !== "routed")
                throw new Error(`unexpected status: ${result.route.status}`);
        }),
    ]);
    return {
        schema_version: "pilot.smoke.v0",
        status: checks.every((item) => item.status === "ok") ? "ok" : "error",
        checks,
    };
}
