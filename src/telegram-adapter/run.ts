import { runPilotCommand, type PilotCommandName, type PilotCommandResult } from "../core/run.ts";
import { appendRunIndexEntry, shortRunId } from "../state/run-index.ts";
import type { PilotRunIndexEntry, RouteResult } from "../types.ts";

export type TelegramChatType = "direct" | "group" | "supergroup" | "channel" | string;

export type TelegramInboundMessage = {
  text?: string;
  chat_id?: string | number;
  sender_id?: string | number;
  message_id?: string | number;
  update_id?: string | number;
  timestamp?: string;
  chat_type?: TelegramChatType;
  trusted_openclaw_sender?: boolean;
};

export type TelegramAuthorizationOptions = {
  allowedChatIds?: string[];
  allowedSenderIds?: string[];
  trustOpenClawSender?: boolean;
  requireDirectChat?: boolean;
};

export type RunTelegramAdapterOptions = {
  message: TelegramInboundMessage;
  enabledCommands: PilotCommandName[];
  authorization?: TelegramAuthorizationOptions;
};

export type TelegramAdapterResult = {
  schema_version: "pilot.telegram_adapter.v0";
  authorized: boolean;
  metadata: Record<string, string>;
  command_result?: PilotCommandResult;
  route?: RouteResult;
  telegram_text: string;
  error_code?: string;
};

const maxTelegramTextLength = 3900;

function idToString(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return String(value);
}

function firstToken(input: string): string {
  return input.trim().split(/\s+/)[0] || "";
}

function truncateTelegramText(text: string): string {
  if (text.length <= maxTelegramTextLength) return text;
  return `${text.slice(0, maxTelegramTextLength - 32)}\n... truncated by Pilot adapter`;
}

function cleanMetadata(message: TelegramInboundMessage): Record<string, string> {
  const metadata: Record<string, string> = {
    channel: "telegram",
  };
  const chatId = idToString(message.chat_id);
  const senderId = idToString(message.sender_id);
  const messageId = idToString(message.message_id);
  const updateId = idToString(message.update_id);

  if (chatId) metadata.chat_id = chatId;
  if (senderId) metadata.sender_id = senderId;
  if (messageId) metadata.message_id = messageId;
  if (updateId) metadata.update_id = updateId;
  if (message.timestamp) metadata.timestamp = message.timestamp;
  if (message.chat_type) metadata.chat_type = message.chat_type;

  return metadata;
}

function isDirectChat(message: TelegramInboundMessage): boolean {
  return !message.chat_type || message.chat_type === "direct";
}

function isAuthorized(message: TelegramInboundMessage, options: TelegramAuthorizationOptions = {}): boolean {
  if (options.requireDirectChat !== false && !isDirectChat(message)) return false;

  if (options.trustOpenClawSender && message.trusted_openclaw_sender) return true;

  const chatId = idToString(message.chat_id);
  if (chatId && options.allowedChatIds?.includes(chatId)) return true;

  const senderId = idToString(message.sender_id);
  if (senderId && options.allowedSenderIds?.includes(senderId)) return true;

  return false;
}

function unauthorizedReply(input: string): string {
  const command = firstToken(input) || "(empty)";
  return [
    "Pilot",
    "Status: unauthorized",
    `Command: ${command}`,
    "",
    "Evidence",
    "- none",
    "",
    "Remaining",
    "- Telegram sender is not authorized for Pilot live commands.",
    "",
    "Next: Use an authorized direct chat or update the Pilot live routing config.",
  ].join("\n");
}

function metadataString(metadata: Record<string, string>, key: string): string | undefined {
  const value = metadata[key]?.trim();
  return value || undefined;
}

async function recordRouteHandoff(route: RouteResult, metadata: Record<string, string>): Promise<void> {
  if (route.command !== "/plan" && route.command !== "/goal" && route.command !== "/verify" && route.command !== "/conv") return;
  const summary = route.result_summary || {};
  const runId = typeof summary.run_id === "string" ? summary.run_id : undefined;
  const artifactDir = typeof summary.artifact_dir === "string" ? summary.artifact_dir : undefined;
  const stateRoot = typeof summary.state_root === "string" ? summary.state_root : undefined;
  if (!runId || !artifactDir || !stateRoot) return;
  if (
    route.user_report.status !== "plan_created" &&
    route.user_report.status !== "goal_plan_created" &&
    route.user_report.status !== "verify_plan_created" &&
    route.user_report.status !== "conv_plan_created"
  ) {
    return;
  }

  const entry: PilotRunIndexEntry = {
    schema_version: "pilot.run_index.v0",
    created_at: new Date().toISOString(),
    channel: metadataString(metadata, "channel") || "telegram",
    chat_id: metadataString(metadata, "chat_id"),
    sender_id: metadataString(metadata, "sender_id"),
    source_message_id: metadataString(metadata, "message_id"),
    source_update_id: metadataString(metadata, "update_id"),
    command: route.command,
    run_id: runId,
    short_run_id: typeof summary.short_run_id === "string" ? summary.short_run_id : shortRunId(runId),
    status: route.user_report.status,
    artifact_dir: artifactDir,
    next_action: route.user_report.next_action,
  };
  await appendRunIndexEntry(stateRoot, entry);
}

export async function runTelegramAdapter(options: RunTelegramAdapterOptions): Promise<TelegramAdapterResult> {
  const text = options.message.text?.trim() || "";
  const metadata = cleanMetadata(options.message);

  if (!isAuthorized(options.message, options.authorization)) {
    return {
      schema_version: "pilot.telegram_adapter.v0",
      authorized: false,
      metadata,
      telegram_text: truncateTelegramText(unauthorizedReply(text)),
      error_code: "telegram_sender_not_authorized",
    };
  }

  const commandResult = await runPilotCommand({
    input: text,
    enabledCommands: options.enabledCommands,
    metadata,
  });
  if (commandResult.route) {
    await recordRouteHandoff(commandResult.route, metadata);
  }

  return {
    schema_version: "pilot.telegram_adapter.v0",
    authorized: true,
    metadata,
    command_result: commandResult,
    route: commandResult.route,
    telegram_text: truncateTelegramText(commandResult.reply_text),
    error_code: commandResult.error_code,
  };
}
