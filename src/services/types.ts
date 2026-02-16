export type ServiceChannel = "telegram" | "website" | "application";
export type ServiceStatus = "ok" | "degraded" | "down";

export interface ServiceCheckResult {
  channel: ServiceChannel;
  status: ServiceStatus;
  checkedAt: string;
  details: string;
}
