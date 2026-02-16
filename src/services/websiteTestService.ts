import type { ServiceCheckResult } from "./types";

export function runWebsiteTestService(): ServiceCheckResult {
  const isEnabled = process.env.TEST_WEBSITE_SERVICE_ENABLED !== "false";

  return {
    channel: "website",
    status: isEnabled ? "ok" : "down",
    checkedAt: new Date().toISOString(),
    details: isEnabled
      ? "Website test service is enabled."
      : "Website test service is disabled by TEST_WEBSITE_SERVICE_ENABLED.",
  };
}
