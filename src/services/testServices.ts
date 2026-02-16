import { runApplicationTestService } from "./applicationTestService";
import { runTelegramTestService } from "./telegramTestService";
import type { ServiceCheckResult } from "./types";
import { runWebsiteTestService } from "./websiteTestService";

export function runAllTestServices(): ServiceCheckResult[] {
  return [runTelegramTestService(), runWebsiteTestService(), runApplicationTestService()];
}
