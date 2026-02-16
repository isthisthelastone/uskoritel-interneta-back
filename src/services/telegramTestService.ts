import type { ServiceCheckResult } from "./types";

export function runTelegramTestService(): ServiceCheckResult {
  const isEnabled = process.env.TEST_TELEGRAM_SERVICE_ENABLED !== "false";

  return {
    channel: "telegram",
    status: isEnabled ? "ok" : "down",
    checkedAt: new Date().toISOString(),
    details: isEnabled
      ? "Telegram test service is enabled."
      : "Telegram test service is disabled by TEST_TELEGRAM_SERVICE_ENABLED.",
  };
}
