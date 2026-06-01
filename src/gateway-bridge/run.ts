import { setTimeout as delay } from "node:timers/promises";
import { runTelegramAdapter, type TelegramInboundMessage } from "../telegram-adapter/run.ts";
import type { GatewayBridgeResult, RouteResult } from "../types.ts";

export type GatewayBridgeInboundMessage = {
  text?: string;
  chat_id?: string | number;
  sender_id?: string | number;
  message_id?: string | number;
  update_id?: string | number;
  timestamp?: string;
  chat_type?: string;
  trusted_openclaw_sender?: boolean;
};

export type GatewayBridgeGate = {
  liveRoutingEnabled?: boolean;
  enabledCommands?: RouteResult["command"][];
  allowedChatIds?: string[];
  allowedSenderIds?: string[];
  trustOpenClawSender?: boolean;
  requireDirectChat?: boolean;
  timeoutMs?: number;
};

export type RunGatewayBridgeOptions = {
  message: GatewayBridgeInboundMessage;
  gate?: GatewayBridgeGate;
};

const defaultTimeoutMs = 2500;
const exactCommands = new Set<RouteResult["command"]>(["/plan", "/verify", "/conv", "/goal", "approve"]);

function startedAt(): bigint {
  return process.hrtime.bigint();
}

function elapsedMs(start: bigint): number {
  return Number((process.hrtime.bigint() - start) / 1_000_000n);
}

function firstToken(input: string): string {
  return input.trim().split(/\s+/)[0] || "";
}

function enabledCommandsForGate(gate: GatewayBridgeGate = {}): RouteResult["command"][] {
  if (!gate.liveRoutingEnabled) return [];
  const configured = gate.enabledCommands || ["/plan"];
  const enabled = configured.filter((command): command is RouteResult["command"] => exactCommands.has(command));
  if (enabled.includes("/plan") && !enabled.includes("approve")) enabled.push("approve");
  if (enabled.includes("/goal") && !enabled.includes("approve")) enabled.push("approve");
  return enabled;
}

function toTelegramMessage(message: GatewayBridgeInboundMessage): TelegramInboundMessage {
  return {
    text: message.text,
    chat_id: message.chat_id,
    sender_id: message.sender_id,
    message_id: message.message_id,
    update_id: message.update_id,
    timestamp: message.timestamp,
    chat_type: message.chat_type,
    trusted_openclaw_sender: message.trusted_openclaw_sender,
  };
}

function timeoutReply(input: string): string {
  const command = firstToken(input) || "(empty)";
  return [
    "Pilot",
    "Status: timeout",
    `Command: ${command}`,
    "",
    "Evidence",
    "- none",
    "",
    "Remaining",
    "- Pilot bridge timed out before a safe route result was produced.",
    "",
    "Next: Retry later or use the local pilot CLI while live routing is checked.",
  ].join("\n");
}

function timeoutResult(options: RunGatewayBridgeOptions, start: bigint, enabledCommands: RouteResult["command"][]): GatewayBridgeResult {
  return {
    schema_version: "pilot.gateway_bridge.v0",
    status: "timeout",
    live_routing_enabled: options.gate?.liveRoutingEnabled === true,
    enabled_commands: enabledCommands,
    telegram_text: timeoutReply(options.message.text || ""),
    duration_ms: elapsedMs(start),
    error_code: "pilot_gateway_bridge_timeout",
  };
}

export async function runGatewayBridge(options: RunGatewayBridgeOptions): Promise<GatewayBridgeResult> {
  const start = startedAt();
  const gate = options.gate || {};
  const enabledCommands = enabledCommandsForGate(gate);
  const timeoutMs = Math.max(1, gate.timeoutMs || defaultTimeoutMs);

  const run = async (): Promise<GatewayBridgeResult> => {
    const result = await runTelegramAdapter({
      message: toTelegramMessage(options.message),
      enabledCommands,
      authorization: {
        allowedChatIds: gate.allowedChatIds,
        allowedSenderIds: gate.allowedSenderIds,
        trustOpenClawSender: gate.trustOpenClawSender !== false,
        requireDirectChat: gate.requireDirectChat !== false,
      },
    });

    return {
      schema_version: "pilot.gateway_bridge.v0",
      status: result.command_result?.status || (result.authorized ? "failed" : "unauthorized"),
      live_routing_enabled: gate.liveRoutingEnabled === true,
      enabled_commands: enabledCommands,
      route: result.route,
      telegram_text: result.telegram_text,
      duration_ms: elapsedMs(start),
      error_code: result.error_code,
    };
  };

  return Promise.race([
    run(),
    delay(timeoutMs).then(() => timeoutResult(options, start, enabledCommands)),
  ]);
}
