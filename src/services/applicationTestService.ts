import type { ServiceCheckResult } from "./types";

export function runApplicationTestService(): ServiceCheckResult {
  const isEnabled = process.env.TEST_APPLICATION_SERVICE_ENABLED !== "false";

  return {
    channel: "application",
    status: isEnabled ? "ok" : "down",
    checkedAt: new Date().toISOString(),
    details: isEnabled
      ? "Application test service is enabled."
      : "Application test service is disabled by TEST_APPLICATION_SERVICE_ENABLED.",
  };
}
