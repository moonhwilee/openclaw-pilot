import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runGatewayBridge } from "../src/gateway-bridge/run.ts";

async function tempStateRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pilot-gateway-state-"));
}

test("Gateway bridge is disabled by default and invokes no legacy fallback", async () => {
  const result = await runGatewayBridge({
    message: {
      text: "/plan Draft a local document strategy plan.",
      chat_id: "343580315",
      sender_id: "343580315",
      chat_type: "direct",
      trusted_openclaw_sender: true,
    },
  });

  assert.equal(result.schema_version, "pilot.gateway_bridge.v0");
  assert.equal(result.live_routing_enabled, false);
  assert.deepEqual(result.enabled_commands, []);
  assert.equal(result.status, "unavailable");
  assert.equal(result.route?.status, "unavailable");
  assert.match(result.telegram_text, /No legacy backend/);
});

test("Gateway bridge routes enabled plan through the Telegram adapter", async () => {
  const previousStateRoot = process.env.PILOT_STATE_ROOT;
  process.env.PILOT_STATE_ROOT = await tempStateRoot();
  try {
    const result = await runGatewayBridge({
      message: {
        text: "/plan Draft a local document strategy plan.",
        chat_id: "343580315",
        sender_id: "343580315",
        message_id: "23022",
        update_id: "99003",
        timestamp: "2026-06-01T04:01:00+09:00",
        chat_type: "direct",
        trusted_openclaw_sender: true,
      },
      gate: {
        liveRoutingEnabled: true,
        enabledCommands: ["/plan"],
        trustOpenClawSender: true,
      },
    });

    assert.equal(result.live_routing_enabled, true);
    assert.deepEqual(result.enabled_commands, ["/plan", "approve"]);
    assert.equal(result.status, "routed");
    assert.equal(result.route?.command, "/plan");
    assert.match(result.telegram_text, /Status: plan_created/);
    assert.match(result.telegram_text, /Run: \d{6}/);
    assert.match(result.telegram_text, /Next: Review the plan. To continue, reply "approve /);
    assert.ok(result.duration_ms >= 0);

    const shortRunId = String(result.route?.result_summary?.short_run_id || "");
    const approval = await runGatewayBridge({
      message: {
        text: `approve ${shortRunId}`,
        chat_id: "343580315",
        sender_id: "343580315",
        message_id: "23023",
        update_id: "99004",
        timestamp: "2026-06-01T04:02:00+09:00",
        chat_type: "direct",
        trusted_openclaw_sender: true,
      },
      gate: {
        liveRoutingEnabled: true,
        enabledCommands: ["/plan"],
        trustOpenClawSender: true,
      },
    });

    assert.equal(approval.status, "routed");
    assert.deepEqual(approval.enabled_commands, ["/plan", "approve"]);
    assert.equal(approval.route?.command, "approve");
    assert.equal(approval.route?.result_summary?.approved_plan_run_id, result.route?.result_summary?.run_id);
    assert.equal(approval.route?.result_summary?.status, "completed");
    assert.match(approval.telegram_text, /Status: completed_verified/);
    assert.match(approval.telegram_text, /Phase: report/);

    const goal = await runGatewayBridge({
      message: {
        text: `/goal ${shortRunId}`,
        chat_id: "343580315",
        sender_id: "343580315",
        message_id: "23024",
        update_id: "99005",
        timestamp: "2026-06-01T04:03:00+09:00",
        chat_type: "direct",
        trusted_openclaw_sender: true,
      },
      gate: {
        liveRoutingEnabled: true,
        enabledCommands: ["/plan", "/goal"],
        trustOpenClawSender: true,
      },
    });

    assert.equal(goal.status, "routed");
    assert.deepEqual(goal.enabled_commands, ["/plan", "/goal", "approve"]);
    assert.equal(goal.route?.command, "/goal");
    assert.equal(goal.route?.result_summary?.approval_reference, result.route?.result_summary?.run_id);
    assert.match(goal.telegram_text, /Status: completed/);
  } finally {
    if (previousStateRoot === undefined) {
      delete process.env.PILOT_STATE_ROOT;
    } else {
      process.env.PILOT_STATE_ROOT = previousStateRoot;
    }
  }
});

test("Gateway bridge routes enabled recovery commands", async () => {
  const previousStateRoot = process.env.PILOT_STATE_ROOT;
  process.env.PILOT_STATE_ROOT = await tempStateRoot();
  try {
    const plan = await runGatewayBridge({
      message: {
        text: "/plan Draft a recovery bridge smoke plan.",
        chat_id: "343580315",
        sender_id: "343580315",
        message_id: "23025",
        update_id: "99006",
        timestamp: "2026-06-01T04:04:00+09:00",
        chat_type: "direct",
        trusted_openclaw_sender: true,
      },
      gate: {
        liveRoutingEnabled: true,
        enabledCommands: ["/plan", "list", "status", "resume", "cancel"],
        trustOpenClawSender: true,
      },
    });

    assert.equal(plan.status, "routed");
    assert.equal(plan.route?.command, "/plan");
    assert.deepEqual(plan.enabled_commands, ["/plan", "list", "status", "resume", "cancel", "approve"]);

    const shortRunId = String(plan.route?.result_summary?.short_run_id || "");
    assert.match(shortRunId, /^\d{6}$/);

    const list = await runGatewayBridge({
      message: {
        text: "list 5",
        chat_id: "343580315",
        sender_id: "343580315",
        message_id: "23026",
        update_id: "99007",
        timestamp: "2026-06-01T04:05:00+09:00",
        chat_type: "direct",
        trusted_openclaw_sender: true,
      },
      gate: {
        liveRoutingEnabled: true,
        enabledCommands: ["list"],
        trustOpenClawSender: true,
      },
    });

    assert.equal(list.status, "routed");
    assert.deepEqual(list.enabled_commands, ["list"]);
    assert.equal(list.route?.command, "list");
    assert.equal(list.route?.user_report.status, "recovery_list");
    assert.match(list.telegram_text, new RegExp(shortRunId));

    const status = await runGatewayBridge({
      message: {
        text: `status ${shortRunId}`,
        chat_id: "343580315",
        sender_id: "343580315",
        message_id: "23027",
        update_id: "99008",
        timestamp: "2026-06-01T04:06:00+09:00",
        chat_type: "direct",
        trusted_openclaw_sender: true,
      },
      gate: {
        liveRoutingEnabled: true,
        enabledCommands: ["status"],
        trustOpenClawSender: true,
      },
    });

    assert.equal(status.status, "routed");
    assert.deepEqual(status.enabled_commands, ["status"]);
    assert.equal(status.route?.command, "status");
    assert.equal(status.route?.result_summary?.status, "recovery_status");
    assert.equal(status.route?.user_report.status, "completed_plan");
    assert.match(status.telegram_text, /Status: completed_plan/);
  } finally {
    if (previousStateRoot === undefined) {
      delete process.env.PILOT_STATE_ROOT;
    } else {
      process.env.PILOT_STATE_ROOT = previousStateRoot;
    }
  }
});

test("Gateway bridge keeps non-enabled commands unavailable behind an enabled gate", async () => {
  const result = await runGatewayBridge({
    message: {
      text: "/verify fixtures/document_strategy/evidence-packet.json",
      chat_id: "343580315",
      sender_id: "343580315",
      chat_type: "direct",
      trusted_openclaw_sender: true,
    },
    gate: {
      liveRoutingEnabled: true,
      enabledCommands: ["/plan"],
      trustOpenClawSender: true,
    },
  });

  assert.equal(result.status, "unavailable");
  assert.equal(result.route?.command, "/verify");
  assert.match(result.telegram_text, /Status: unavailable/);
  assert.match(result.telegram_text, /No legacy backend/);
});

test("Gateway bridge rejects unauthorized Gateway messages", async () => {
  const result = await runGatewayBridge({
    message: {
      text: "/plan Draft a local document strategy plan.",
      chat_id: "999",
      sender_id: "999",
      chat_type: "direct",
      trusted_openclaw_sender: false,
    },
    gate: {
      liveRoutingEnabled: true,
      enabledCommands: ["/plan"],
      allowedChatIds: ["343580315"],
      trustOpenClawSender: false,
    },
  });

  assert.equal(result.status, "unauthorized");
  assert.equal(result.route, undefined);
  assert.equal(result.error_code, "telegram_sender_not_authorized");
  assert.match(result.telegram_text, /Status: unauthorized/);
  assert.doesNotMatch(result.telegram_text, /stack|Error:|src\//);
});

test("Gateway bridge returns a safe timeout result", async () => {
  const result = await runGatewayBridge({
    message: {
      text: "/plan Draft a local document strategy plan.",
      chat_id: "343580315",
      sender_id: "343580315",
      chat_type: "direct",
      trusted_openclaw_sender: true,
    },
    gate: {
      liveRoutingEnabled: true,
      enabledCommands: ["/plan"],
      trustOpenClawSender: true,
      timeoutMs: 1,
    },
  });

  assert.equal(result.status, "timeout");
  assert.equal(result.error_code, "pilot_gateway_bridge_timeout");
  assert.match(result.telegram_text, /Status: timeout/);
  assert.doesNotMatch(result.telegram_text, /stack|Error:|src\//);
});
