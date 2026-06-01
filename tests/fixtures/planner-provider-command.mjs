import process from "node:process";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const start = input.lastIndexOf("\n{");
  const end = input.lastIndexOf("}");
  const payload = JSON.parse(input.slice(start + 1, end + 1));
  const mode = payload.mode || "goal";
  console.log(
    JSON.stringify({
      kind: "draft",
      draft: {
        title: "Command Provider Draft",
        mode,
        understood_request: `command-provider: ${payload.request}`,
        assumptions: [`chat=${payload.source?.chat_id || "missing"}`, `turns=${payload.prior_interview_turns?.length || 0}`],
        approach: ["Use the command-backed OpenClaw orchestrator provider path."],
        steps: ["Create provider-backed planning output."],
        verification: ["Verify the provider command received request and source context."],
        approval_boundary: ["Execution still requires approval of the typed execution plan."],
        not_doing_yet: ["No execution was performed by the planning provider."],
      },
    }),
  );
});
