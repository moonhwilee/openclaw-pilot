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
  console.log(
    JSON.stringify({
      kind: "draft",
      draft: {
        title: "Loose Provider Draft",
        goal: payload.request,
        summary: `loose-provider: ${payload.request}`,
        scope: ["Normalize compatible provider draft fields."],
        out_of_scope: ["Do not execute from provider output."],
        steps: ["Accept the provider draft only as presentation data."],
        success_criteria: ["Rendered draft uses the standard user-facing shape."],
        risks_assumptions: ["Provider output can use adjacent planning terms."],
        approval_boundary: "Execution still requires approval of the typed execution plan.",
      },
    }),
  );
});
