import type { LiveAdapterResult, RouteResult } from "../types.ts";
import { runTelegramAdapter } from "../telegram-adapter/run.ts";

export type RunLiveAdapterOptions = {
  input: string;
  enabledCommands: RouteResult["command"][];
};

export async function runLiveAdapter(options: RunLiveAdapterOptions): Promise<LiveAdapterResult> {
  const result = await runTelegramAdapter({
    message: {
      text: options.input,
      chat_id: "local-live-adapter",
      sender_id: "local-live-adapter",
      chat_type: "direct",
      trusted_openclaw_sender: true,
    },
    enabledCommands: options.enabledCommands,
    authorization: {
      trustOpenClawSender: true,
      requireDirectChat: true,
    },
  });

  if (!result.route) {
    throw new Error(result.error_code || "pilot live adapter could not produce a route");
  }

  return {
    schema_version: "pilot.live_adapter.v0",
    route: result.route,
    telegram_text: result.telegram_text,
  };
}
