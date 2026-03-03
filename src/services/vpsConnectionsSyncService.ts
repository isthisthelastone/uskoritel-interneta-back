import { z } from "zod";
import { getSupabaseAdminClient } from "../lib/supabaseAdmin";
import { runVpsSshCommandWithConfig, type VpsSshConfig } from "./vpsSshService";

const DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_USER_IP_LIMIT = 5;
const DEFAULT_XRAY_STATS_SERVER = "127.0.0.1:10085";
const DEFAULT_XRAY_ACCESS_LOG_PATH = "/var/log/xray/access.log";
const DEFAULT_XRAY_LOG_TAIL_LINES = 5_000;
const DEFAULT_USER_IP_CURRENT_WINDOW_MINUTES = 20;
const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu;
const IPV4_PATTERN = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/u;

const vpsSyncRowSchema = z.object({
  internal_uuid: z.uuid(),
  domain: z.string().min(1),
  api_address: z.string().min(1),
  ssh_key: z.string().min(1),
  password: z.string().min(1),
  optional_passsword: z.string().nullable(),
  config_list: z.array(z.string()),
  users_kv_map: z.unknown(),
});

const userVpsTrafficMonthlyStateRowSchema = z.object({
  vps_internal_uuid: z.uuid(),
  user_internal_uuid: z.uuid(),
  last_total_bytes: z.union([z.number(), z.string()]),
  month_key: z.string().min(1),
  month_consumed_bytes: z.union([z.number(), z.string()]),
});

interface UserAggregate {
  currentIps: Set<string>;
  monthIps: Set<string>;
}

interface PerVpsMetrics {
  activeIps: Set<string>;
  userCurrentIps: Map<string, Set<string>>;
  userMonthIps: Map<string, Set<string>>;
  userTrafficBytes: Map<string, number>;
}

interface UserVpsTrafficMonthlyStateRow {
  vpsInternalUuid: string;
  userInternalUuid: string;
  lastTotalBytes: number;
  monthKey: string;
  monthConsumedBytes: number;
}

interface AbuseEvent {
  internalUuid: string;
  userInternalUuid: string;
  ips: string[];
  ports: number[];
}

export interface VpsNodeSyncSummary {
  internalUuid: string;
  domain: string;
  activeIpCount: number;
  abusiveUsers: string[];
}

export interface VpsConnectionsSyncResult {
  syncedAt: string;
  processedVps: number;
  updatedUsers: number;
  droppedUsers: number;
  nodes: VpsNodeSyncSummary[];
}

let syncIntervalTimer: NodeJS.Timeout | null = null;

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

function decodeBase64OrKeepRaw(rawValue: string): string {
  const normalizedRaw = rawValue.trim();

  if (normalizedRaw.length === 0) {
    return normalizedRaw;
  }

  let decoded: string;

  try {
    decoded = Buffer.from(normalizedRaw, "base64").toString("utf8");
  } catch {
    return normalizedRaw;
  }

  if (decoded.length === 0) {
    return normalizedRaw;
  }

  const normalizedDecoded = Buffer.from(decoded, "utf8").toString("base64").replace(/=+$/u, "");
  const normalizedSource = normalizedRaw.replace(/=+$/u, "");

  return normalizedDecoded === normalizedSource ? decoded : normalizedRaw;
}

function parseSshKey(sshKey: string): { user: string; host: string | null; port: number | null } {
  const trimmed = sshKey.trim();

  if (trimmed.length === 0) {
    return {
      user: "root",
      host: null,
      port: null,
    };
  }

  const [left, right] = trimmed.includes("@") ? trimmed.split("@", 2) : ["root", trimmed];
  const user = left.trim().length > 0 ? left.trim() : "root";
  const hostPart = right.trim();

  if (hostPart.length === 0) {
    return {
      user,
      host: null,
      port: null,
    };
  }

  const maybePortIndex = hostPart.lastIndexOf(":");

  if (maybePortIndex > 0 && maybePortIndex < hostPart.length - 1) {
    const hostCandidate = hostPart.slice(0, maybePortIndex).trim();
    const portCandidate = Number.parseInt(hostPart.slice(maybePortIndex + 1).trim(), 10);

    if (Number.isFinite(portCandidate) && portCandidate > 0 && portCandidate <= 65535) {
      return {
        user,
        host: hostCandidate,
        port: portCandidate,
      };
    }
  }

  return {
    user,
    host: hostPart,
    port: null,
  };
}

function buildVpsSshConfig(row: z.infer<typeof vpsSyncRowSchema>): VpsSshConfig {
  const parsedSshKey = parseSshKey(row.ssh_key);
  const decodedMainPassword = decodeBase64OrKeepRaw(row.password);
  const optionalPassword =
    row.optional_passsword !== null && row.optional_passsword.trim().length > 0
      ? decodeBase64OrKeepRaw(row.optional_passsword)
      : undefined;
  const sshPassword =
    decodedMainPassword.trim().length > 0 ? decodedMainPassword : optionalPassword;

  if (sshPassword === undefined || sshPassword.trim().length === 0) {
    throw new Error("VPS SSH password is empty for " + row.internal_uuid);
  }

  return {
    host: parsedSshKey.host ?? row.api_address,
    user: parsedSshKey.user,
    port: parsedSshKey.port ?? 22,
    password: sshPassword,
  };
}

function parseVpsSyncRow(rawRow: unknown): z.infer<typeof vpsSyncRowSchema> {
  return vpsSyncRowSchema.parse(rawRow);
}

function parseNonNegativeInteger(rawValue: string | number): number {
  const parsedValue =
    typeof rawValue === "number" ? rawValue : Number.parseInt(rawValue.trim(), 10);

  if (
    !Number.isFinite(parsedValue) ||
    parsedValue < 0 ||
    parsedValue > Number.MAX_SAFE_INTEGER ||
    !Number.isInteger(parsedValue)
  ) {
    throw new Error("Invalid non-negative integer in traffic state row.");
  }

  return parsedValue;
}

function parseUserVpsTrafficMonthlyStateRow(rawRow: unknown): UserVpsTrafficMonthlyStateRow {
  const row = userVpsTrafficMonthlyStateRowSchema.parse(rawRow);
  return {
    vpsInternalUuid: row.vps_internal_uuid,
    userInternalUuid: row.user_internal_uuid,
    lastTotalBytes: parseNonNegativeInteger(row.last_total_bytes),
    monthKey: row.month_key,
    monthConsumedBytes: parseNonNegativeInteger(row.month_consumed_bytes),
  };
}

function buildCurrentMonthKeyUtc(now: Date): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return String(year) + "-" + month + "-01";
}

function parseUsersKvMapKeys(usersKvMap: unknown): string[] {
  if (typeof usersKvMap !== "object" || usersKvMap === null || Array.isArray(usersKvMap)) {
    return [];
  }

  return Object.keys(usersKvMap).filter((key) => UUID_PATTERN.test(key));
}

function parsePortFromConfigUrl(configUrl: string): number | null {
  try {
    const parsed = new URL(configUrl);

    if (parsed.port.length > 0) {
      const explicit = Number.parseInt(parsed.port, 10);
      if (Number.isFinite(explicit) && explicit > 0 && explicit <= 65535) {
        return explicit;
      }
    }

    if (parsed.protocol === "trojan:") {
      return 443;
    }

    return null;
  } catch {
    return null;
  }
}

function extractVpsPorts(configList: string[]): number[] {
  const portSet = new Set<number>();

  for (const configUrl of configList) {
    const parsedPort = parsePortFromConfigUrl(configUrl);

    if (parsedPort !== null) {
      portSet.add(parsedPort);
    }
  }

  if (portSet.size === 0) {
    portSet.add(443);
    portSet.add(8443);
  }

  return Array.from(portSet.values()).sort((a, b) => a - b);
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

function getUserIpLimit(): number {
  const rawLimit = process.env.VPS_USER_MAX_UNIQUE_IPS;

  if (rawLimit === undefined || rawLimit.length === 0) {
    return DEFAULT_USER_IP_LIMIT;
  }

  const parsed = Number.parseInt(rawLimit, 10);

  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("VPS_USER_MAX_UNIQUE_IPS must be between 1 and 100.");
  }

  return parsed;
}

function getCurrentWindowMinutes(): number {
  const rawWindow = process.env.VPS_USER_IP_CURRENT_WINDOW_MINUTES;

  if (rawWindow === undefined || rawWindow.length === 0) {
    return DEFAULT_USER_IP_CURRENT_WINDOW_MINUTES;
  }

  const parsed = Number.parseInt(rawWindow, 10);

  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 24 * 60) {
    throw new Error("VPS_USER_IP_CURRENT_WINDOW_MINUTES must be between 1 and 1440.");
  }

  return parsed;
}

function getXrayStatsServer(): string {
  return process.env.XRAY_STATS_SERVER?.trim() || DEFAULT_XRAY_STATS_SERVER;
}

function getXrayAccessLogPath(): string {
  return process.env.XRAY_ACCESS_LOG_PATH?.trim() || DEFAULT_XRAY_ACCESS_LOG_PATH;
}

function getXrayLogTailLines(): number {
  const rawLines = process.env.XRAY_ACCESS_LOG_TAIL_LINES;

  if (rawLines === undefined || rawLines.length === 0) {
    return DEFAULT_XRAY_LOG_TAIL_LINES;
  }

  const parsed = Number.parseInt(rawLines, 10);

  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 200_000) {
    throw new Error("XRAY_ACCESS_LOG_TAIL_LINES must be between 1 and 200000.");
  }

  return parsed;
}

function buildDistinctActiveIpCommand(ports: number[]): string {
  const ssPortsClause = ports.map((port) => "sport = :" + String(port)).join(" or ");
  const netstatPortsClause = ports
    .map((port) => "$4 ~ /:" + String(port).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$/")
    .join(" || ");

  return (
    "if command -v ss >/dev/null 2>&1; then " +
    "ss -Htan state established '( " +
    ssPortsClause +
    " )' | awk '{print $5}'; " +
    "else " +
    'netstat -tan 2>/dev/null | awk \'$6 == "ESTABLISHED" && (' +
    netstatPortsClause +
    ") {print $5}'; " +
    "fi"
  );
}

function buildStatsQueryCommand(statsServer: string): string {
  return (
    "if command -v xray >/dev/null 2>&1; then " +
    "xray api statsquery --server=" +
    shellQuote(statsServer) +
    " 2>/dev/null || true; " +
    "elif [ -x /usr/local/bin/xray ]; then " +
    "/usr/local/bin/xray api statsquery --server=" +
    shellQuote(statsServer) +
    " 2>/dev/null || true; " +
    "else " +
    "true; " +
    "fi"
  );
}

function buildReadAccessLogsCommand(accessLogPath: string, tailLines: number): string {
  return (
    "if [ -f " +
    shellQuote(accessLogPath) +
    " ]; then " +
    "tail -n " +
    String(tailLines) +
    " " +
    shellQuote(accessLogPath) +
    "; " +
    "elif command -v journalctl >/dev/null 2>&1; then " +
    "journalctl -u xray --no-pager -n " +
    String(tailLines) +
    "; " +
    "else " +
    "true; " +
    "fi"
  );
}

function extractIpv4(value: string): string | null {
  const match = value.match(IPV4_PATTERN);
  return match === null ? null : match[0];
}

function parseDistinctIps(stdout: string): Set<string> {
  const ips = new Set<string>();

  for (const rawLine of stdout.split(/\r?\n/u)) {
    const ip = extractIpv4(rawLine);

    if (ip !== null) {
      ips.add(ip);
    }
  }

  return ips;
}

function parseLogDate(line: string): Date | null {
  const slashDateMatch = line.match(/\b(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\b/u);

  if (slashDateMatch !== null) {
    const [, year, month, day, hour, minute, second] = slashDateMatch;
    const parsed = new Date(
      Number.parseInt(year, 10),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10),
      Number.parseInt(hour, 10),
      Number.parseInt(minute, 10),
      Number.parseInt(second, 10),
    );

    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const isoDateMatch = line.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/u);

  if (isoDateMatch !== null) {
    const parsed = new Date(isoDateMatch[0]);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

function parseUserIpSetsFromLogs(
  logOutput: string,
  currentWindowMinutes: number,
): {
  userCurrentIps: Map<string, Set<string>>;
  userMonthIps: Map<string, Set<string>>;
} {
  const userCurrentIps = new Map<string, Set<string>>();
  const userMonthIps = new Map<string, Set<string>>();
  const now = Date.now();
  const currentWindowStart = now - currentWindowMinutes * 60 * 1000;
  const monthWindowStart = now - 30 * 24 * 60 * 60 * 1000;

  for (const line of logOutput.split(/\r?\n/u)) {
    const userIdMatch = line.match(UUID_PATTERN);
    const ip = extractIpv4(line);

    if (userIdMatch === null || ip === null) {
      continue;
    }

    const userInternalUuid = userIdMatch[0].toLowerCase();
    const logDate = parseLogDate(line);
    const logTs = logDate?.getTime();
    const inCurrentWindow = logTs === undefined || logTs >= currentWindowStart;
    const inMonthWindow = logTs === undefined || logTs >= monthWindowStart;

    if (inCurrentWindow) {
      const existingCurrent = userCurrentIps.get(userInternalUuid) ?? new Set<string>();
      existingCurrent.add(ip);
      userCurrentIps.set(userInternalUuid, existingCurrent);
    }

    if (inMonthWindow) {
      const existingMonth = userMonthIps.get(userInternalUuid) ?? new Set<string>();
      existingMonth.add(ip);
      userMonthIps.set(userInternalUuid, existingMonth);
    }
  }

  return {
    userCurrentIps,
    userMonthIps,
  };
}

function parseUserTrafficBytesFromStats(statsOutput: string): Map<string, number> {
  const userTrafficBytes = new Map<string, number>();
  let pendingUserInternalUuid: string | null = null;

  for (const rawLine of statsOutput.split(/\r?\n/u)) {
    const line = rawLine.trim();

    if (line.length === 0) {
      continue;
    }

    const metricMatch = line.match(/user>>>(.*?)>>>traffic>>>(uplink|downlink)/iu);

    if (metricMatch !== null) {
      const uuidMatch = metricMatch[1].match(UUID_PATTERN);
      pendingUserInternalUuid = uuidMatch === null ? null : uuidMatch[0].toLowerCase();
    }

    const valueMatch = line.match(/\bvalue:\s*(\d+)\b/iu);

    if (valueMatch === null || pendingUserInternalUuid === null) {
      continue;
    }

    const value = Number.parseInt(valueMatch[1], 10);

    if (!Number.isFinite(value) || value < 0) {
      pendingUserInternalUuid = null;
      continue;
    }

    const current = userTrafficBytes.get(pendingUserInternalUuid) ?? 0;
    userTrafficBytes.set(pendingUserInternalUuid, current + value);
    pendingUserInternalUuid = null;
  }

  if (userTrafficBytes.size === 0) {
    const inlinePattern = /user>>>(.*?)>>>traffic>>>(?:uplink|downlink)[^0-9]*(\d+)/giu;
    let inlineMatch = inlinePattern.exec(statsOutput);

    while (inlineMatch !== null) {
      const uuidMatch = inlineMatch[1].match(UUID_PATTERN);

      if (uuidMatch !== null) {
        const userInternalUuid = uuidMatch[0].toLowerCase();
        const value = Number.parseInt(inlineMatch[2], 10);

        if (Number.isFinite(value) && value >= 0) {
          const current = userTrafficBytes.get(userInternalUuid) ?? 0;
          userTrafficBytes.set(userInternalUuid, current + value);
        }
      }

      inlineMatch = inlinePattern.exec(statsOutput);
    }
  }

  return userTrafficBytes;
}

function buildDropUserConnectionsCommand(ips: string[], ports: number[]): string {
  if (ips.length === 0 || ports.length === 0) {
    return "true";
  }

  const quotedIps = ips.map((ip) => shellQuote(ip)).join(" ");
  const dropCommands = ports
    .map(
      (port) =>
        'ss -K src "$ip" dport = :' +
        String(port) +
        " 2>/dev/null || true; " +
        "ss -K dst :" +
        String(port) +
        ' src "$ip" 2>/dev/null || true',
    )
    .join("; ");

  return (
    "if command -v ss >/dev/null 2>&1; then " +
    "for ip in " +
    quotedIps +
    "; do " +
    dropCommands +
    "; done; " +
    "else " +
    "true; " +
    "fi"
  );
}

function toRoundedMb(totalBytes: number): number {
  const value = totalBytes / (1024 * 1024);
  return Math.round(value);
}

async function collectVpsMetrics(sshConfig: VpsSshConfig, ports: number[]): Promise<PerVpsMetrics> {
  const activeIpsCommand = buildDistinctActiveIpCommand(ports);
  const statsCommand = buildStatsQueryCommand(getXrayStatsServer());
  const readLogsCommand = buildReadAccessLogsCommand(getXrayAccessLogPath(), getXrayLogTailLines());

  const [activeIpsResult, statsResult, logsResult] = await Promise.all([
    runVpsSshCommandWithConfig(sshConfig, activeIpsCommand),
    runVpsSshCommandWithConfig(sshConfig, statsCommand),
    runVpsSshCommandWithConfig(sshConfig, readLogsCommand),
  ]);

  const activeIps = parseDistinctIps(activeIpsResult.stdout);
  const userTrafficBytes = parseUserTrafficBytesFromStats(statsResult.stdout);
  const userIpSets = parseUserIpSetsFromLogs(logsResult.stdout, getCurrentWindowMinutes());

  if (userTrafficBytes.size === 0 && statsResult.stdout.trim().length > 0) {
    console.warn(
      "[vps-sync] statsquery returned data but no user traffic rows were parsed; sample=" +
        statsResult.stdout.slice(0, 300).replaceAll(/\s+/gu, " "),
    );
  }

  return {
    activeIps,
    userCurrentIps: userIpSets.userCurrentIps,
    userMonthIps: userIpSets.userMonthIps,
    userTrafficBytes,
  };
}

function buildUserVpsTrafficStateKey(vpsInternalUuid: string, userInternalUuid: string): string {
  return vpsInternalUuid + "::" + userInternalUuid;
}

async function computeCalendarMonthTrafficByUser(params: {
  vpsInternalUuids: string[];
  perVpsUserTotals: Map<string, number>;
  now: Date;
}): Promise<Map<string, number>> {
  if (params.vpsInternalUuids.length === 0) {
    return new Map<string, number>();
  }

  const supabase = getSupabaseAdminClient();
  const currentMonthKey = buildCurrentMonthKeyUtc(params.now);
  const { data, error } = await supabase
    .from("user_vps_traffic_monthly_state")
    .select(
      "vps_internal_uuid, user_internal_uuid, last_total_bytes, month_key, month_consumed_bytes",
    )
    .in("vps_internal_uuid", params.vpsInternalUuids);

  if (error !== null) {
    throw new Error("Failed to fetch user_vps_traffic_monthly_state rows: " + error.message);
  }

  const stateMap = new Map<string, UserVpsTrafficMonthlyStateRow>();

  for (const rawRow of data) {
    const parsedRow = parseUserVpsTrafficMonthlyStateRow(rawRow);
    stateMap.set(
      buildUserVpsTrafficStateKey(parsedRow.vpsInternalUuid, parsedRow.userInternalUuid),
      parsedRow,
    );
  }

  const upsertRows: Array<{
    vps_internal_uuid: string;
    user_internal_uuid: string;
    last_total_bytes: number;
    month_key: string;
    month_consumed_bytes: number;
  }> = [];

  for (const [key, currentTotalBytes] of params.perVpsUserTotals.entries()) {
    const separatorIndex = key.indexOf("::");

    if (separatorIndex <= 0 || separatorIndex >= key.length - 2) {
      continue;
    }

    const vpsInternalUuid = key.slice(0, separatorIndex);
    const userInternalUuid = key.slice(separatorIndex + 2);

    const existing = stateMap.get(key);
    const deltaBytes =
      existing === undefined
        ? currentTotalBytes
        : currentTotalBytes >= existing.lastTotalBytes
          ? currentTotalBytes - existing.lastTotalBytes
          : currentTotalBytes;
    const nextMonthConsumedBytes =
      existing !== undefined && existing.monthKey === currentMonthKey
        ? existing.monthConsumedBytes + deltaBytes
        : deltaBytes;
    const nextState: UserVpsTrafficMonthlyStateRow = {
      vpsInternalUuid,
      userInternalUuid,
      lastTotalBytes: currentTotalBytes,
      monthKey: currentMonthKey,
      monthConsumedBytes: nextMonthConsumedBytes,
    };

    stateMap.set(key, nextState);
    upsertRows.push({
      vps_internal_uuid: nextState.vpsInternalUuid,
      user_internal_uuid: nextState.userInternalUuid,
      last_total_bytes: nextState.lastTotalBytes,
      month_key: nextState.monthKey,
      month_consumed_bytes: nextState.monthConsumedBytes,
    });
  }

  if (upsertRows.length > 0) {
    const { error: upsertError } = await supabase
      .from("user_vps_traffic_monthly_state")
      .upsert(upsertRows, {
        onConflict: "vps_internal_uuid,user_internal_uuid",
      });

    if (upsertError !== null) {
      throw new Error(
        "Failed to upsert user_vps_traffic_monthly_state rows: " + upsertError.message,
      );
    }
  }

  const monthBytesByUser = new Map<string, number>();

  for (const row of stateMap.values()) {
    if (row.monthKey !== currentMonthKey) {
      continue;
    }

    const currentBytes = monthBytesByUser.get(row.userInternalUuid) ?? 0;
    monthBytesByUser.set(row.userInternalUuid, currentBytes + row.monthConsumedBytes);
  }

  return monthBytesByUser;
}

async function dropAbusiveUserConnections(
  sshConfig: VpsSshConfig,
  userInternalUuid: string,
  ips: Set<string>,
  ports: number[],
): Promise<boolean> {
  const ipsList = Array.from(ips.values()).filter((ip) => IPV4_PATTERN.test(ip));

  if (ipsList.length === 0) {
    return false;
  }

  const command = buildDropUserConnectionsCommand(ipsList, ports);
  await runVpsSshCommandWithConfig(sshConfig, command);
  console.warn("[vps-sync] dropped abusive user connections", userInternalUuid, ipsList.join(","));
  return true;
}

export async function syncVpsCurrentConnections(): Promise<VpsConnectionsSyncResult> {
  const userIpLimit = getUserIpLimit();
  const syncNow = new Date();
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("vps")
    .select(
      "internal_uuid, domain, api_address, ssh_key, password, optional_passsword, config_list, users_kv_map",
    );

  if (error !== null) {
    throw new Error("Failed to fetch VPS rows for sync: " + error.message);
  }

  const parsedRows = data.map((rawRow) => parseVpsSyncRow(rawRow));
  const userAggregates = new Map<string, UserAggregate>();
  const perVpsUserTotals = new Map<string, number>();
  const pendingAbuseEvents: Array<{ sshConfig: VpsSshConfig; event: AbuseEvent }> = [];
  const nodeSummaries: VpsNodeSyncSummary[] = [];

  for (const row of parsedRows) {
    const sshConfig = buildVpsSshConfig(row);
    const ports = extractVpsPorts(row.config_list);
    const metrics = await collectVpsMetrics(sshConfig, ports);
    const knownUserIds = parseUsersKvMapKeys(row.users_kv_map);
    const abusiveUsers: string[] = [];

    for (const userId of knownUserIds) {
      if (!userAggregates.has(userId)) {
        userAggregates.set(userId, {
          currentIps: new Set<string>(),
          monthIps: new Set<string>(),
        });
      }
    }

    for (const [userId, bytes] of metrics.userTrafficBytes.entries()) {
      const stateKey = buildUserVpsTrafficStateKey(row.internal_uuid, userId);
      perVpsUserTotals.set(stateKey, bytes);

      if (!userAggregates.has(userId)) {
        userAggregates.set(userId, {
          currentIps: new Set<string>(),
          monthIps: new Set<string>(),
        });
      }
    }

    for (const [userId, ips] of metrics.userCurrentIps.entries()) {
      const aggregate = userAggregates.get(userId) ?? {
        currentIps: new Set<string>(),
        monthIps: new Set<string>(),
      };

      for (const ip of ips.values()) {
        aggregate.currentIps.add(ip);
      }

      userAggregates.set(userId, aggregate);

      if (aggregate.currentIps.size > userIpLimit) {
        abusiveUsers.push(userId);
        pendingAbuseEvents.push({
          sshConfig,
          event: {
            internalUuid: row.internal_uuid,
            userInternalUuid: userId,
            ips: Array.from(aggregate.currentIps.values()),
            ports,
          },
        });
      }
    }

    for (const [userId, ips] of metrics.userMonthIps.entries()) {
      const aggregate = userAggregates.get(userId) ?? {
        currentIps: new Set<string>(),
        monthIps: new Set<string>(),
      };

      for (const ip of ips.values()) {
        aggregate.monthIps.add(ip);
      }

      userAggregates.set(userId, aggregate);
    }

    const { error: updateVpsError } = await supabase
      .from("vps")
      .update({
        number_of_connections: metrics.activeIps.size,
      })
      .eq("internal_uuid", row.internal_uuid);

    if (updateVpsError !== null) {
      throw new Error("Failed to update VPS number_of_connections: " + updateVpsError.message);
    }

    nodeSummaries.push({
      internalUuid: row.internal_uuid,
      domain: row.domain,
      activeIpCount: metrics.activeIps.size,
      abusiveUsers,
    });
  }

  let droppedUsers = 0;

  for (const pending of pendingAbuseEvents) {
    const dropped = await dropAbusiveUserConnections(
      pending.sshConfig,
      pending.event.userInternalUuid,
      new Set(pending.event.ips),
      pending.event.ports,
    );

    if (dropped) {
      droppedUsers += 1;
    }
  }

  const monthTrafficBytesByUser = await computeCalendarMonthTrafficByUser({
    vpsInternalUuids: parsedRows.map((row) => row.internal_uuid),
    perVpsUserTotals,
    now: syncNow,
  });

  for (const userId of monthTrafficBytesByUser.keys()) {
    if (!userAggregates.has(userId)) {
      userAggregates.set(userId, {
        currentIps: new Set<string>(),
        monthIps: new Set<string>(),
      });
    }
  }

  let updatedUsers = 0;

  for (const [userId, aggregate] of userAggregates.entries()) {
    const monthTrafficBytes = monthTrafficBytesByUser.get(userId) ?? 0;
    const { error: updateUserError } = await supabase
      .from("users")
      .update({
        traffic_consumed_mb: toRoundedMb(monthTrafficBytes),
        number_of_connections: aggregate.currentIps.size,
        number_of_connections_last_month: aggregate.monthIps.size,
      })
      .eq("internal_uuid", userId);

    if (updateUserError !== null) {
      throw new Error("Failed to update user usage stats: " + updateUserError.message);
    }

    updatedUsers += 1;
  }

  return {
    syncedAt: new Date().toISOString(),
    processedVps: parsedRows.length,
    updatedUsers,
    droppedUsers,
    nodes: nodeSummaries,
  };
}

async function runSyncSafely(trigger: string): Promise<void> {
  try {
    const result = await syncVpsCurrentConnections();
    console.log(
      "[vps-sync]",
      trigger,
      "processedVps=" + String(result.processedVps),
      "updatedUsers=" + String(result.updatedUsers),
      "droppedUsers=" + String(result.droppedUsers),
    );
  } catch (error) {
    if (error instanceof Error) {
      console.error("[vps-sync]", trigger, "failed:", error.message);
    } else {
      console.error("[vps-sync]", trigger, "failed:", error);
    }
  }
}

export function startVpsConnectionsSyncJob(): void {
  if (syncIntervalTimer !== null) {
    return;
  }

  const syncEnabledRaw = process.env.VPS_CONNECTION_SYNC_ENABLED?.trim().toLowerCase();
  const syncEnabled = syncEnabledRaw !== "false";

  if (!syncEnabled) {
    console.log("[vps-sync] disabled by VPS_CONNECTION_SYNC_ENABLED=false");
    return;
  }

  const intervalMs = getSyncIntervalMs();
  console.log("[vps-sync] starting; intervalMs=" + String(intervalMs));
  void runSyncSafely("startup");

  syncIntervalTimer = setInterval(() => {
    void runSyncSafely("interval");
  }, intervalMs);

  syncIntervalTimer.unref();
}
