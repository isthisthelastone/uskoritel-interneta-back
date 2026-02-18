import { getSupabaseAdminClient } from "../lib/supabaseAdmin";
import { runVpsSshCommand } from "./vpsSshService";

const DEFAULT_SYNC_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_VPN_PORTS = [443, 8443];

export interface VpsConnectionsSyncResult {
  domain: string;
  ports: number[];
  activeConnections: number;
  syncedAt: string;
}

let syncIntervalTimer: NodeJS.Timeout | null = null;

function getSyncDomain(): string {
  const domain = process.env.VPS_SYNC_TARGET_DOMAIN ?? process.env.VPS_DOMAIN;

  if (domain === undefined || domain.length === 0) {
    throw new Error("VPS_SYNC_TARGET_DOMAIN or VPS_DOMAIN must be configured.");
  }

  return domain;
}

function getSyncPorts(): number[] {
  const rawPorts = process.env.VPS_SYNC_PORTS;

  if (rawPorts === undefined || rawPorts.trim().length === 0) {
    return DEFAULT_VPN_PORTS;
  }

  const parsedPorts = rawPorts
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0 && value <= 65535);

  if (parsedPorts.length === 0) {
    throw new Error("VPS_SYNC_PORTS is configured but contains no valid ports.");
  }

  return parsedPorts;
}

function getSyncIntervalMs(): number {
  const rawInterval = process.env.VPS_CONNECTION_SYNC_INTERVAL_MS;

  if (rawInterval === undefined || rawInterval.length === 0) {
    return DEFAULT_SYNC_INTERVAL_MS;
  }

  const parsed = Number.parseInt(rawInterval, 10);

  if (!Number.isFinite(parsed) || parsed < 60_000) {
    throw new Error("VPS_CONNECTION_SYNC_INTERVAL_MS must be at least 60000.");
  }

  return parsed;
}

function buildConnectionCountCommand(ports: number[]): string {
  const ssPortsClause = ports.map((port) => "sport = :" + String(port)).join(" or ");

  return (
    "if command -v ss >/dev/null 2>&1; then " +
    "ss -Htan state established '( " +
    ssPortsClause +
    " )' | wc -l; " +
    "else " +
    "netstat -tan 2>/dev/null | awk '$6 == \"ESTABLISHED\"' | wc -l; " +
    "fi"
  );
}

function parseConnectionCount(stdout: string): number {
  const rawValue = stdout.trim();
  const parsed = Number.parseInt(rawValue, 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("Failed to parse active connections count from VPS output: " + rawValue);
  }

  return parsed;
}

export async function syncVpsCurrentConnections(): Promise<VpsConnectionsSyncResult> {
  const domain = getSyncDomain();
  const ports = getSyncPorts();
  const command = buildConnectionCountCommand(ports);
  const sshResult = await runVpsSshCommand(command);
  const activeConnections = parseConnectionCount(sshResult.stdout);

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("vps")
    .update({
      number_of_connections: activeConnections,
    })
    .eq("domain", domain)
    .select("domain")
    .maybeSingle();

  if (error !== null) {
    throw new Error("Failed to update VPS connection count: " + error.message);
  }

  if (data === null) {
    throw new Error("VPS row not found for domain: " + domain);
  }

  return {
    domain,
    ports,
    activeConnections,
    syncedAt: new Date().toISOString(),
  };
}

async function runSyncSafely(trigger: string): Promise<void> {
  try {
    const result = await syncVpsCurrentConnections();
    console.log(
      "[vps-sync]",
      trigger,
      "domain=" + result.domain,
      "connections=" + String(result.activeConnections),
    );
  } catch (error) {
    console.error("[vps-sync]", trigger, "failed:", error);
  }
}

export function startVpsConnectionsSyncJob(): void {
  if (syncIntervalTimer !== null) {
    return;
  }

  if (process.env.VPS_CONNECTION_SYNC_ENABLED !== "true") {
    return;
  }

  const intervalMs = getSyncIntervalMs();
  void runSyncSafely("startup");

  syncIntervalTimer = setInterval(() => {
    void runSyncSafely("interval");
  }, intervalMs);

  syncIntervalTimer.unref();
}
