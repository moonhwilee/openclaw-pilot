import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTelegramAdapter } from "../src/telegram-adapter/run.ts";

async function tempStateRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pilot-telegram-state-"));
}

test("Telegram adapter routes authorized enabled plan messages", async () => {
  const previousStateRoot = process.env.PILOT_STATE_ROOT;
  process.env.PILOT_STATE_ROOT = await tempStateRoot();
  try {
    const result = await runTelegramAdapter({
      message: {
        text: "/plan Draft a local document strategy plan.",
        chat_id: "343580315",
        sender_id: "343580315",
        message_id: "23020",
        update_id: "99001",
        timestamp: "2026-06-01T03:55:00+09:00",
        chat_type: "direct",
      },
      enabledCommands: ["/plan"],
      authorization: {
        allowedChatIds: ["343580315"],
      },
    });

    assert.equal(result.schema_version, "pilot.telegram_adapter.v0");
    assert.equal(result.authorized, true);
    assert.equal(result.command_result?.status, "routed");
    assert.equal(result.route?.command, "/plan");
    assert.match(result.telegram_text, /Status: plan_created/);
    assert.match(result.telegram_text, /Run: \d{6}/);
    assert.match(result.telegram_text, /Next: Review the plan. To continue, reply "approve /);
    assert.ok(result.telegram_text.length < 4000);
    assert.deepEqual(result.command_result?.metadata, {
      channel: "telegram",
      chat_id: "343580315",
      sender_id: "343580315",
      message_id: "23020",
      update_id: "99001",
      timestamp: "2026-06-01T03:55:00+09:00",
      chat_type: "direct",
    });
    const indexText = await readFile(join(process.env.PILOT_STATE_ROOT || "", "index", "runs.jsonl"), "utf8");
    const indexEntry = JSON.parse(indexText.trim());
    assert.equal(indexEntry.schema_version, "pilot.run_index.v0");
    assert.equal(indexEntry.chat_id, "343580315");
    assert.equal(indexEntry.sender_id, "343580315");
    assert.equal(indexEntry.source_message_id, "23020");
    assert.equal(indexEntry.command, "/plan");
    assert.match(indexEntry.run_id, /^.+draft-a-local-document-strategy-plan$/);
    assert.match(indexEntry.short_run_id, /^\d{6}$/);

    const approval = await runTelegramAdapter({
      message: {
        text: `approve ${indexEntry.short_run_id}`,
        chat_id: "343580315",
        sender_id: "343580315",
        message_id: "23021",
        update_id: "99002",
        timestamp: "2026-06-01T03:56:00+09:00",
        chat_type: "direct",
      },
      enabledCommands: ["/plan"],
      authorization: {
        allowedChatIds: ["343580315"],
      },
    });

    assert.equal(approval.authorized, true);
    assert.equal(approval.command_result?.status, "routed");
    assert.equal(approval.route?.command, "approve");
    assert.equal(approval.route?.result_summary?.approved_plan_run_id, indexEntry.run_id);
    assert.equal(approval.route?.result_summary?.status, "completed");
    assert.match(approval.telegram_text, /Status: completed_verified/);
    assert.match(approval.telegram_text, /Phase: report/);
    assert.match(approval.telegram_text, /receipts\.jsonl/);

    const status = await runTelegramAdapter({
      message: {
        text: `status ${indexEntry.short_run_id}`,
        chat_id: "343580315",
        sender_id: "343580315",
        message_id: "23022",
        update_id: "99003",
        timestamp: "2026-06-01T03:57:00+09:00",
        chat_type: "direct",
      },
      enabledCommands: ["/plan"],
      authorization: {
        allowedChatIds: ["343580315"],
      },
    });

    assert.equal(status.authorized, true);
    assert.equal(status.command_result?.status, "routed");
    assert.equal(status.route?.command, "status");
    assert.match(status.telegram_text, /Status: approved/);
    assert.match(status.telegram_text, /Command: status/);
  } finally {
    if (previousStateRoot === undefined) {
      delete process.env.PILOT_STATE_ROOT;
    } else {
      process.env.PILOT_STATE_ROOT = previousStateRoot;
    }
  }
});

test("Telegram adapter records authorized freeform goal intake handoffs", async () => {
  const previousStateRoot = process.env.PILOT_STATE_ROOT;
  process.env.PILOT_STATE_ROOT = await tempStateRoot();
  try {
    const result = await runTelegramAdapter({
      message: {
        text: "/goal Build a tiny local dashboard prototype for reviewing Pilot receipts.",
        chat_id: "343580315",
        sender_id: "343580315",
        message_id: "23151",
        update_id: "99051",
        timestamp: "2026-06-01T06:45:00+09:00",
        chat_type: "direct",
      },
      enabledCommands: ["/goal"],
      authorization: {
        allowedChatIds: ["343580315"],
      },
    });

    assert.equal(result.authorized, true);
    assert.equal(result.command_result?.status, "routed");
    assert.equal(result.route?.command, "/goal");
    assert.equal(result.route?.user_report.status, "goal_plan_created");
    assert.match(result.telegram_text, /Status: goal_plan_created/);
    assert.match(result.telegram_text, /Run: \d{6}/);
    assert.match(result.telegram_text, /approve \d{6}/);

    const indexText = await readFile(join(process.env.PILOT_STATE_ROOT || "", "index", "runs.jsonl"), "utf8");
    const indexEntry = JSON.parse(indexText.trim());
    assert.equal(indexEntry.command, "/goal");
    assert.equal(indexEntry.status, "goal_plan_created");
    assert.equal(indexEntry.source_message_id, "23151");
  } finally {
    if (previousStateRoot === undefined) {
      delete process.env.PILOT_STATE_ROOT;
    } else {
      process.env.PILOT_STATE_ROOT = previousStateRoot;
    }
  }
});

test("Telegram adapter shows usage for empty Pilot slash commands", async () => {
  for (const command of ["/plan", "/goal", "/verify", "/conv"] as const) {
    const result = await runTelegramAdapter({
      message: {
        text: command,
        chat_id: "343580315",
        sender_id: "343580315",
        chat_type: "direct",
      },
      enabledCommands: [command],
      authorization: {
        allowedChatIds: ["343580315"],
      },
    });

    assert.equal(result.authorized, true);
    assert.equal(result.command_result?.status, "needs_user_decision");
    assert.equal(result.command_result?.error_code, undefined);
    assert.equal(result.route?.command, command);
    assert.match(result.telegram_text, /Status: command_needs_input/);
    assert.match(result.telegram_text, /Usage/);
    assert.match(result.telegram_text, /Example/);
    assert.doesNotMatch(result.telegram_text, /Pilot command failed/);
  }
});

test("Telegram adapter keeps disabled commands unavailable without fallback", async () => {
  const result = await runTelegramAdapter({
    message: {
      text: "/verify fixtures/document_strategy/evidence-packet.json",
      chat_id: "343580315",
      sender_id: "343580315",
      chat_type: "direct",
    },
    enabledCommands: ["/plan"],
    authorization: {
      allowedChatIds: ["343580315"],
    },
  });

  assert.equal(result.authorized, true);
  assert.equal(result.command_result?.status, "unavailable");
  assert.equal(result.route?.status, "unavailable");
  assert.match(result.route?.fallback_message || "", /No legacy backend/);
  assert.match(result.telegram_text, /Status: unavailable/);
  assert.match(result.telegram_text, /No legacy backend/);
});

test("Telegram adapter rejects unsupported commands safely", async () => {
  const result = await runTelegramAdapter({
    message: {
      text: "/oldgoal do something",
      chat_id: "343580315",
      sender_id: "343580315",
      chat_type: "direct",
    },
    enabledCommands: ["/goal"],
    authorization: {
      allowedChatIds: ["343580315"],
    },
  });

  assert.equal(result.authorized, true);
  assert.equal(result.command_result?.status, "unsupported");
  assert.equal(result.route, undefined);
  assert.equal(result.error_code, "unsupported_exact_command");
  assert.match(result.telegram_text, /Unsupported Pilot exact command/);
});

test("Telegram adapter denies unauthorized chats without exposing internals", async () => {
  const result = await runTelegramAdapter({
    message: {
      text: "/plan Draft a local document strategy plan.",
      chat_id: "999",
      sender_id: "999",
      chat_type: "direct",
    },
    enabledCommands: ["/plan"],
    authorization: {
      allowedChatIds: ["343580315"],
    },
  });

  assert.equal(result.authorized, false);
  assert.equal(result.command_result, undefined);
  assert.equal(result.route, undefined);
  assert.equal(result.error_code, "telegram_sender_not_authorized");
  assert.match(result.telegram_text, /Status: unauthorized/);
  assert.doesNotMatch(result.telegram_text, /stack|Error:|src\//);
});

test("Telegram adapter can trust OpenClaw sender metadata for direct chats", async () => {
  const result = await runTelegramAdapter({
    message: {
      text: "/verify fixtures/document_strategy/evidence-packet.json",
      chat_id: "runtime-direct",
      sender_id: "runtime-sender",
      chat_type: "direct",
      trusted_openclaw_sender: true,
    },
    enabledCommands: ["/verify"],
    authorization: {
      trustOpenClawSender: true,
    },
  });

  assert.equal(result.authorized, true);
  assert.equal(result.command_result?.status, "routed");
  assert.equal(result.route?.command, "/verify");
});
