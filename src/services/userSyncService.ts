import { z } from "zod";
import { getSupabaseAdminClient } from "../lib/supabaseAdmin";
import { parseDateOnly } from "../shared";
import { runVpsSshCommandWithConfig, type VpsSshConfig } from "./vpsSshService";
import { removeVpsXrayUserFromAllProtocols } from "./vpsXrayService";

const DEFAULT_USER_SYNC_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_USER_IP_LIMIT = 5;
const DEFAULT_TRIAL_UNBLOCK_ACCESS_HOURS = 6;
const DEFAULT_XRAY_ACCESS_LOG_PATH = "/var/log/xray/access.log";
const DEFAULT_XRAY_ACCESS_LOG_TAIL_LINES = 5_000;
const DEFAULT_USER_IP_CURRENT_WINDOW_MINUTES = 20;
const DEFAULT_UNBLOCK_SSH_USER = "unluckypleasure";
const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu;
const IPV4_PATTERN = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/u;

const userSyncUserRowSchema = z.object({
  internal_uuid: z.uuid(),
  created_at: z.string(),
  tg_id: z.string().min(1),
  subscription_active: z.boolean(),
  subscription_status: z.enum(["live", "ending"]).nullable(),
  subscription_untill: z.string().nullable(),
  has_purchased: z.boolean(),
  number_of_connections: z.number().int().nonnegative(),
  connections_by_server: z.record(z.string(), z.number().nonnegative()).optional().default({}),
});

const userSyncVpsRowSchema = z.object({
  internal_uuid: z.uuid(),
  api_address: z.string().min(1),
  domain: z.string().min(1),
  ssh_key: z.string().nullable().optional(),
  ssh_connection_key: z.string().nullable().optional(),
  isUnblock: z.boolean().nullable().optional(),
  password: z.string().nullable().optional(),
  optional_passsword: z.string().nullable(),
  users_kv_map: z.unknown(),
  config_list: z.array(z.string()),
  disabled: z.boolean().nullable().optional(),
  connection: z.boolean().nullable().optional(),
});

interface UserSyncUserRow {
  internalUuid: string;
  createdAt: string;
  tgId: string;
  subscriptionActive: boolean;
  subscriptionStatus: "live" | "ending" | null;
  subscriptionUntill: string | null;
  hasPurchased: boolean;
  numberOfConnections: number;
  connectionsByServer: Record<string, number>;
}

interface UserSyncVpsState {
  row: z.infer<typeof userSyncVpsRowSchema>;
  usersKvMap: Record<string, unknown>;
  configList: string[];
  sshConfig: VpsSshConfig | null;
  resolveUserInternalUuid: (metricIdentity: string) => string | null;
  liveUserIps: Map<string, Set<string>>;
  changed: boolean;
}

interface UserSyncResult {
  processedUsers: number;
  processedVps: number;
  subscriptionStatusUpdatedUsers: number;
  expiredUsers: number;
  cleanedUsers: number;
  cleanedServers: number;
  trialUnblockRestrictedUsers: number;
  trialUnblockCleanedServers: number;
  overLimitUsers: number;
  droppedUsers: number;
  droppedIps: number;
  connectionStatsUpdatedUsers: number;
  failedActions: number;
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

function decodeBase64Strict(rawValue: string): string | null {
  try {
    const decoded = Buffer.from(rawValue, "base64").toString("utf8").trim();
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
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

function getUnblockSshUser(): string {
  const rawUser = process.env.VPS_UNBLOCK_SSH_USER?.trim();
  return rawUser !== undefined && rawUser.length > 0 ? rawUser : DEFAULT_UNBLOCK_SSH_USER;
}

function buildVpsSshConfig(row: z.infer<typeof userSyncVpsRowSchema>): VpsSshConfig {
  if (row.isUnblock === true) {
    const sshConnectionKey = row.ssh_connection_key?.trim();

    if (sshConnectionKey === undefined || sshConnectionKey.length === 0) {
      throw new Error("VPS ssh_connection_key is empty for " + row.internal_uuid);
    }

    return {
      host: row.api_address,
      user: getUnblockSshUser(),
      port: 22,
      privateKeyPath: sshConnectionKey,
    };
  }

  const sshKey = row.ssh_key?.trim();

  if (sshKey === undefined || sshKey.length === 0) {
    throw new Error("VPS ssh_key is empty for " + row.internal_uuid);
  }

  const parsedSshKey = parseSshKey(sshKey);
  const decodedMainPassword =
    row.password !== undefined && row.password !== null ? decodeBase64OrKeepRaw(row.password) : "";
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

function getXrayAccessLogPath(): string {
  return process.env.XRAY_ACCESS_LOG_PATH?.trim() || DEFAULT_XRAY_ACCESS_LOG_PATH;
}

function getXrayLogTailLines(): number {
  const rawLines = process.env.XRAY_ACCESS_LOG_TAIL_LINES;

  if (rawLines === undefined || rawLines.length === 0) {
    return DEFAULT_XRAY_ACCESS_LOG_TAIL_LINES;
  }

  const parsed = Number.parseInt(rawLines, 10);

  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 200_000) {
    return DEFAULT_XRAY_ACCESS_LOG_TAIL_LINES;
  }

  return parsed;
}

function buildReadAccessLogsCommand(accessLogPath: string, tailLines: number): string {
  return (
    "if [ -r " +
    shellQuote(accessLogPath) +
    " ]; then " +
    "tail -n " +
    String(tailLines) +
    " " +
    shellQuote(accessLogPath) +
    " 2>/dev/null || true; " +
    "elif command -v sudo >/dev/null 2>&1 && sudo -n test -r " +
    shellQuote(accessLogPath) +
    " >/dev/null 2>&1; then " +
    "sudo -n tail -n " +
    String(tailLines) +
    " " +
    shellQuote(accessLogPath) +
    " 2>/dev/null || true; " +
    "elif command -v journalctl >/dev/null 2>&1; then " +
    "journalctl -u xray --no-pager -n " +
    String(tailLines) +
    " 2>/dev/null || true; " +
    "else " +
    "true; " +
    "fi"
  );
}

function parseJsonLineObject(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();

  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractIpv4(value: string): string | null {
  const match = value.match(IPV4_PATTERN);
  return match === null ? null : match[0];
}

function extractIpFromUnknown(rawValue: unknown): string | null {
  if (typeof rawValue !== "string") {
    return null;
  }

  return extractIpv4(rawValue);
}

function normalizeMetricIdentityToken(rawValue: string): string {
  return rawValue.trim().replaceAll(/^['"]+|['",;]+$/gu, "");
}

function extractLogMetricIdentityFromUnknown(rawValue: unknown): string | null {
  if (typeof rawValue !== "string") {
    return null;
  }

  const normalized = normalizeMetricIdentityToken(rawValue);
  return normalized.length > 0 ? normalized : null;
}

function extractUserMetricIdentityFromLogLine(line: string): string | null {
  const jsonObject = parseJsonLineObject(line);

  if (jsonObject !== null) {
    const candidateKeys = [
      "email",
      "user",
      "userId",
      "user_id",
      "client",
      "clientId",
      "client_id",
      "uid",
      "tag",
      "password",
      "secret",
      "id",
    ];

    for (const key of candidateKeys) {
      const candidate = extractLogMetricIdentityFromUnknown(jsonObject[key]);

      if (candidate !== null) {
        return candidate.toLowerCase();
      }
    }
  }

  const taggedMetricMatch = line.match(
    /\b(?:email|user|client|uid|tag|id|password|secret)\s*[:=]\s*["']?([^"'\s,;]+)/iu,
  );

  if (taggedMetricMatch !== null) {
    const normalized = normalizeMetricIdentityToken(taggedMetricMatch[1]).toLowerCase();

    if (normalized.length > 0) {
      return normalized;
    }
  }

  const rawMatch = line.match(UUID_PATTERN);
  return rawMatch === null ? null : rawMatch[0].toLowerCase();
}

function extractSourceIpFromLogLine(line: string): string | null {
  const jsonObject = parseJsonLineObject(line);

  if (jsonObject !== null) {
    const candidateKeys = [
      "source",
      "src",
      "client",
      "clientIp",
      "client_ip",
      "remote",
      "remoteAddr",
      "remote_addr",
      "peer",
    ];

    for (const key of candidateKeys) {
      const candidate = extractIpFromUnknown(jsonObject[key]);

      if (candidate !== null) {
        return candidate;
      }
    }
  }

  const fromMatch = line.match(/\bfrom\s+((?:\d{1,3}\.){3}\d{1,3})(?::\d+)?\b/iu);

  if (fromMatch !== null) {
    return fromMatch[1];
  }

  return extractIpv4(line);
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

function parseCurrentUserIpsFromLogs(
  logOutput: string,
  currentWindowMinutes: number,
  resolveUserInternalUuid: (metricIdentity: string) => string | null,
): Map<string, Set<string>> {
  const userCurrentIps = new Map<string, Set<string>>();
  const now = Date.now();
  const currentWindowStart = now - currentWindowMinutes * 60 * 1000;

  for (const line of logOutput.split(/\r?\n/u)) {
    const metricIdentity = extractUserMetricIdentityFromLogLine(line);
    const ip = extractSourceIpFromLogLine(line);

    if (metricIdentity === null || ip === null) {
      continue;
    }

    const userInternalUuid = resolveUserInternalUuid(metricIdentity);

    if (userInternalUuid === null) {
      continue;
    }

    const logDate = parseLogDate(line);
    const logTs = logDate?.getTime();
    const inCurrentWindow = logTs === undefined || logTs >= currentWindowStart;

    if (!inCurrentWindow) {
      continue;
    }

    const existing = userCurrentIps.get(userInternalUuid) ?? new Set<string>();
    existing.add(ip);
    userCurrentIps.set(userInternalUuid, existing);
  }

  return userCurrentIps;
}

function parseUserIpsFromLogsWithResolver(
  logOutput: string,
  userInternalUuid: string,
  resolveUserInternalUuid: (metricIdentity: string) => string | null,
): string[] {
  const normalizedUserUuid = userInternalUuid.toLowerCase();
  const ips = new Set<string>();

  for (const line of logOutput.split(/\r?\n/u)) {
    const metricIdentity = extractUserMetricIdentityFromLogLine(line);

    if (metricIdentity === null) {
      continue;
    }

    const resolvedUserInternalUuid = resolveUserInternalUuid(metricIdentity);

    if (resolvedUserInternalUuid === null || resolvedUserInternalUuid !== normalizedUserUuid) {
      continue;
    }

    const ip = extractSourceIpFromLogLine(line);

    if (ip !== null) {
      ips.add(ip);
    }
  }

  return Array.from(ips.values());
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

function collectConfigUrlsFromUnknown(value: unknown, acc: Set<string>, depth = 0): void {
  if (depth > 6 || value === null || value === undefined) {
    return;
  }

  if (typeof value === "string") {
    if (
      value.startsWith("trojan://") ||
      value.startsWith("vless://") ||
      value.startsWith("ss://")
    ) {
      acc.add(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectConfigUrlsFromUnknown(item, acc, depth + 1);
    }
    return;
  }

  if (typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      collectConfigUrlsFromUnknown(nested, acc, depth + 1);
    }
  }
}

function parseTrojanPasswordFromConfigUrl(configUrl: string): string | null {
  try {
    const parsed = new URL(configUrl);

    if (parsed.protocol !== "trojan:") {
      return null;
    }

    const password = decodeURIComponent(parsed.username).trim();
    return password.length > 0 ? password : null;
  } catch {
    return null;
  }
}

function extractTrojanPasswordsFromUsersKvEntry(userEntry: unknown): string[] {
  if (typeof userEntry !== "object" || userEntry === null || Array.isArray(userEntry)) {
    return [];
  }

  const entryObject = userEntry as Record<string, unknown>;
  const passwords = new Set<string>();
  const addPassword = (value: string | null): void => {
    if (value === null) {
      return;
    }

    const trimmed = value.trim();
    if (trimmed.length > 0) {
      passwords.add(trimmed);
    }
  };

  if (typeof entryObject.passwordBase64 === "string") {
    addPassword(decodeBase64OrKeepRaw(entryObject.passwordBase64));
  }

  if (typeof entryObject.directUrl === "string") {
    addPassword(parseTrojanPasswordFromConfigUrl(entryObject.directUrl));
  }

  if (typeof entryObject.obfsUrl === "string") {
    addPassword(parseTrojanPasswordFromConfigUrl(entryObject.obfsUrl));
  }

  const protocolsRaw = entryObject.protocols;

  if (typeof protocolsRaw === "object" && protocolsRaw !== null && !Array.isArray(protocolsRaw)) {
    const protocols = protocolsRaw as Record<string, unknown>;

    for (const protocolKey of ["trojan", "trojan_obfuscated"]) {
      const protocolRaw = protocols[protocolKey];

      if (typeof protocolRaw !== "object" || protocolRaw === null || Array.isArray(protocolRaw)) {
        continue;
      }

      const protocolEntry = protocolRaw as Record<string, unknown>;

      if (typeof protocolEntry.secretBase64 === "string") {
        addPassword(decodeBase64OrKeepRaw(protocolEntry.secretBase64));
      }

      if (typeof protocolEntry.url === "string") {
        addPassword(parseTrojanPasswordFromConfigUrl(protocolEntry.url));
      }
    }
  }

  const urlsSet = new Set<string>();
  collectConfigUrlsFromUnknown(userEntry, urlsSet);

  for (const configUrl of urlsSet.values()) {
    addPassword(parseTrojanPasswordFromConfigUrl(configUrl));
  }

  return Array.from(passwords.values());
}

function parseUsersKvMap(rawValue: unknown): Record<string, unknown> {
  if (typeof rawValue !== "object" || rawValue === null || Array.isArray(rawValue)) {
    return {};
  }

  return { ...(rawValue as Record<string, unknown>) };
}

function parseUsersKvMapKeys(usersKvMap: Record<string, unknown>): string[] {
  return Object.keys(usersKvMap).filter((key) => UUID_PATTERN.test(key));
}

function parseSecretCandidatesFromConfigUrl(configUrl: string): string[] {
  const parsedSecrets = new Set<string>();

  try {
    const parsed = new URL(configUrl);
    const scheme = parsed.protocol.toLowerCase();

    if (scheme === "trojan:" || scheme === "vless:") {
      const secret = decodeURIComponent(parsed.username).trim();

      if (secret.length > 0) {
        parsedSecrets.add(secret);
      }
    } else if (scheme === "ss:") {
      if (parsed.password.length > 0) {
        const password = decodeURIComponent(parsed.password).trim();

        if (password.length > 0) {
          parsedSecrets.add(password);
        }
      } else {
        const rawUsername = decodeURIComponent(parsed.username).trim();
        const decodedUsername = decodeBase64Strict(rawUsername);
        const usernameCandidate = decodedUsername ?? rawUsername;
        const separatorIndex = usernameCandidate.indexOf(":");

        if (separatorIndex > -1 && separatorIndex < usernameCandidate.length - 1) {
          const password = usernameCandidate.slice(separatorIndex + 1).trim();

          if (password.length > 0) {
            parsedSecrets.add(password);
          }
        }
      }
    }
  } catch {
    return [];
  }

  return Array.from(parsedSecrets.values());
}

function buildLogMetricUserResolver(
  usersKvMap: Record<string, unknown>,
): (metricIdentity: string) => string | null {
  const knownUserIds = new Set(parseUsersKvMapKeys(usersKvMap).map((key) => key.toLowerCase()));
  const aliasToUser = new Map<string, string>();
  const addAlias = (userInternalUuid: string, rawAlias: unknown): void => {
    if (typeof rawAlias !== "string") {
      return;
    }

    const trimmed = rawAlias.trim();

    if (trimmed.length === 0) {
      return;
    }

    aliasToUser.set(trimmed, userInternalUuid);
    aliasToUser.set(trimmed.toLowerCase(), userInternalUuid);
  };

  for (const userInternalUuid of knownUserIds.values()) {
    addAlias(userInternalUuid, userInternalUuid);
  }

  for (const [rawUserId, rawEntry] of Object.entries(usersKvMap)) {
    const userUuidMatch = rawUserId.match(UUID_PATTERN);

    if (userUuidMatch === null) {
      continue;
    }

    const userInternalUuid = userUuidMatch[0].toLowerCase();
    addAlias(userInternalUuid, userInternalUuid);

    if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) {
      continue;
    }

    const entry = rawEntry as Record<string, unknown>;

    if (typeof entry.passwordBase64 === "string") {
      addAlias(userInternalUuid, decodeBase64Strict(entry.passwordBase64));
    }

    for (const urlKey of ["directUrl", "obfsUrl"]) {
      const rawUrl = entry[urlKey];

      if (typeof rawUrl !== "string") {
        continue;
      }

      for (const secret of parseSecretCandidatesFromConfigUrl(rawUrl)) {
        addAlias(userInternalUuid, secret);
      }
    }

    const protocolsRaw = entry.protocols;

    if (typeof protocolsRaw === "object" && protocolsRaw !== null && !Array.isArray(protocolsRaw)) {
      for (const protocolEntryRaw of Object.values(protocolsRaw as Record<string, unknown>)) {
        if (
          typeof protocolEntryRaw !== "object" ||
          protocolEntryRaw === null ||
          Array.isArray(protocolEntryRaw)
        ) {
          continue;
        }

        const protocolEntry = protocolEntryRaw as Record<string, unknown>;

        if (typeof protocolEntry.secretBase64 === "string") {
          addAlias(userInternalUuid, decodeBase64Strict(protocolEntry.secretBase64));
        }

        if (typeof protocolEntry.url === "string") {
          for (const secret of parseSecretCandidatesFromConfigUrl(protocolEntry.url)) {
            addAlias(userInternalUuid, secret);
          }
        }
      }
    }
  }

  return (metricIdentity: string): string | null => {
    const rawIdentity = metricIdentity.trim();

    if (rawIdentity.length === 0) {
      return null;
    }

    const byAlias = aliasToUser.get(rawIdentity) ?? aliasToUser.get(rawIdentity.toLowerCase());

    if (byAlias !== undefined) {
      return byAlias;
    }

    const uuidMatch = rawIdentity.match(UUID_PATTERN);

    if (uuidMatch !== null) {
      return uuidMatch[0].toLowerCase();
    }

    return null;
  };
}

function removeUserFromUsersKvMap(
  usersKvMap: Record<string, unknown>,
  userInternalUuid: string,
): {
  nextUsersKvMap: Record<string, unknown>;
  removedUrls: string[];
  trojanPasswords: string[];
  removed: boolean;
} {
  if (!Object.hasOwn(usersKvMap, userInternalUuid)) {
    return {
      nextUsersKvMap: usersKvMap,
      removedUrls: [],
      trojanPasswords: [],
      removed: false,
    };
  }

  const userEntry = usersKvMap[userInternalUuid];
  const removedUrlsSet = new Set<string>();
  collectConfigUrlsFromUnknown(userEntry, removedUrlsSet);
  const trojanPasswords = extractTrojanPasswordsFromUsersKvEntry(userEntry);

  const nextUsersKvMap = Object.fromEntries(
    Object.entries(usersKvMap).filter(([entryKey]) => entryKey !== userInternalUuid),
  );

  return {
    nextUsersKvMap,
    removedUrls: Array.from(removedUrlsSet),
    trojanPasswords,
    removed: true,
  };
}

function removeUrlsFromConfigList(configList: string[], urlsToRemove: string[]): string[] {
  if (urlsToRemove.length === 0) {
    return configList;
  }

  const blocked = new Set(urlsToRemove);
  return configList.filter((configUrl) => !blocked.has(configUrl));
}

function parseUserRow(rawRow: unknown): UserSyncUserRow {
  const parsed = userSyncUserRowSchema.parse(rawRow);
  return {
    internalUuid: parsed.internal_uuid,
    createdAt: parsed.created_at,
    tgId: parsed.tg_id,
    subscriptionActive: parsed.subscription_active,
    subscriptionStatus: parsed.subscription_status,
    subscriptionUntill: parsed.subscription_untill,
    hasPurchased: parsed.has_purchased,
    numberOfConnections: parsed.number_of_connections,
    connectionsByServer: parsed.connections_by_server,
  };
}

function getUserSyncIntervalMs(): number {
  const rawInterval = process.env.USER_SYNC_TIMING?.trim();

  if (rawInterval === undefined || rawInterval.length === 0) {
    return DEFAULT_USER_SYNC_INTERVAL_MS;
  }

  const parsed = Number.parseInt(rawInterval, 10);

  if (!Number.isFinite(parsed) || parsed < 60_000) {
    throw new Error("USER_SYNC_TIMING must be at least 60000 (ms).");
  }

  return parsed;
}

function getUserIpLimit(): number {
  const rawLimit = process.env.USER_SYNC_MAX_UNIQUE_IPS?.trim();

  if (rawLimit === undefined || rawLimit.length === 0) {
    return DEFAULT_USER_IP_LIMIT;
  }

  const parsed = Number.parseInt(rawLimit, 10);

  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 200) {
    throw new Error("USER_SYNC_MAX_UNIQUE_IPS must be between 1 and 200.");
  }

  return parsed;
}

function getCurrentWindowMinutes(): number {
  const rawWindow = process.env.USER_SYNC_CURRENT_WINDOW_MINUTES?.trim();

  if (rawWindow === undefined || rawWindow.length === 0) {
    return DEFAULT_USER_IP_CURRENT_WINDOW_MINUTES;
  }

  const parsed = Number.parseInt(rawWindow, 10);

  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 240) {
    throw new Error("USER_SYNC_CURRENT_WINDOW_MINUTES must be between 1 and 240.");
  }

  return parsed;
}

function getTrialUnblockAccessHours(): number {
  const rawHours = process.env.USER_SYNC_TRIAL_UNBLOCK_ACCESS_HOURS?.trim();

  if (rawHours === undefined || rawHours.length === 0) {
    return DEFAULT_TRIAL_UNBLOCK_ACCESS_HOURS;
  }

  const parsed = Number.parseInt(rawHours, 10);

  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 168) {
    throw new Error("USER_SYNC_TRIAL_UNBLOCK_ACCESS_HOURS must be between 1 and 168.");
  }

  return parsed;
}

function isUserSyncEnabled(): boolean {
  const raw = process.env.USER_SYNC_ENABLED?.trim().toLowerCase();

  if (raw === undefined || raw.length === 0) {
    return true;
  }

  return raw !== "false" && raw !== "0" && raw !== "off";
}

function isVerboseUserSyncEnabled(): boolean {
  return process.env.USER_SYNC_VERBOSE?.trim().toLowerCase() === "true";
}

function isSubscriptionExpired(user: UserSyncUserRow, todayUtcStart: Date): boolean {
  if (user.subscriptionUntill === null) {
    return false;
  }

  const parsedUntil = parseDateOnly(user.subscriptionUntill);

  if (parsedUntil === null) {
    return false;
  }

  return parsedUntil.getTime() < todayUtcStart.getTime();
}

function isTrialUnblockWindowExpired(
  user: UserSyncUserRow,
  nowMs: number,
  trialUnblockAccessHours: number,
): boolean {
  if (user.hasPurchased) {
    return false;
  }

  if (!user.subscriptionActive || user.subscriptionStatus !== "ending") {
    return false;
  }

  const createdAtMs = Date.parse(user.createdAt);

  if (!Number.isFinite(createdAtMs)) {
    return false;
  }

  const elapsedMs = nowMs - createdAtMs;

  if (elapsedMs < 0) {
    return false;
  }

  return elapsedMs > trialUnblockAccessHours * 60 * 60 * 1000;
}

function resolveDesiredSubscriptionState(
  user: UserSyncUserRow,
  todayUtcStart: Date,
): { subscriptionActive: boolean; subscriptionStatus: "live" | "ending" | null } | null {
  if (user.subscriptionUntill === null) {
    return null;
  }

  const parsedUntil = parseDateOnly(user.subscriptionUntill);

  if (parsedUntil === null) {
    return null;
  }

  if (parsedUntil.getTime() < todayUtcStart.getTime()) {
    return {
      subscriptionActive: false,
      subscriptionStatus: null,
    };
  }

  const endingThreshold = new Date(todayUtcStart);
  endingThreshold.setUTCDate(endingThreshold.getUTCDate() + 3);
  const isEnding = parsedUntil.getTime() <= endingThreshold.getTime();

  return {
    subscriptionActive: true,
    subscriptionStatus: isEnding ? "ending" : "live",
  };
}

async function dropUserConnectionsOnServer(
  sshConfig: VpsSshConfig,
  userInternalUuid: string,
  ports: number[],
  resolveUserInternalUuid: (metricIdentity: string) => string | null,
): Promise<number> {
  const readLogsCommand = buildReadAccessLogsCommand(getXrayAccessLogPath(), getXrayLogTailLines());
  const logsResult = await runVpsSshCommandWithConfig(sshConfig, readLogsCommand);
  const userIps = parseUserIpsFromLogsWithResolver(
    logsResult.stdout,
    userInternalUuid,
    resolveUserInternalUuid,
  );

  if (userIps.length === 0) {
    return 0;
  }

  const dropCommand = buildDropUserConnectionsCommand(userIps, ports);
  await runVpsSshCommandWithConfig(sshConfig, dropCommand);
  return userIps.length;
}

async function dropUserConnectionsByKnownIpsOnServer(
  sshConfig: VpsSshConfig,
  ips: Set<string>,
  ports: number[],
): Promise<number> {
  if (ips.size === 0) {
    return 0;
  }

  const dropCommand = buildDropUserConnectionsCommand(Array.from(ips.values()), ports);
  await runVpsSshCommandWithConfig(sshConfig, dropCommand);
  return ips.size;
}

async function runUserSync(): Promise<UserSyncResult> {
  const supabase = getSupabaseAdminClient();
  const userIpLimit = getUserIpLimit();
  const trialUnblockAccessHours = getTrialUnblockAccessHours();
  const verbose = isVerboseUserSyncEnabled();
  const currentWindowMinutes = getCurrentWindowMinutes();
  const todayUtcStart = new Date();
  todayUtcStart.setUTCHours(0, 0, 0, 0);
  const nowMs = Date.now();
  let failedActions = 0;

  const usersResult = await supabase
    .from("users")
    .select(
      "internal_uuid, created_at, tg_id, subscription_active, subscription_status, subscription_untill, has_purchased, number_of_connections, connections_by_server",
    );

  if (usersResult.error !== null) {
    throw new Error("Failed to fetch users for user-sync: " + usersResult.error.message);
  }

  const users = usersResult.data.map((rawRow) => parseUserRow(rawRow));
  let subscriptionStatusUpdatedUsers = 0;

  for (const user of users) {
    const desiredState = resolveDesiredSubscriptionState(user, todayUtcStart);

    if (desiredState === null) {
      continue;
    }

    if (
      user.subscriptionActive === desiredState.subscriptionActive &&
      user.subscriptionStatus === desiredState.subscriptionStatus
    ) {
      continue;
    }

    const updateSubscriptionResult = await supabase
      .from("users")
      .update({
        subscription_active: desiredState.subscriptionActive,
        subscription_status: desiredState.subscriptionStatus,
      })
      .eq("internal_uuid", user.internalUuid);

    if (updateSubscriptionResult.error !== null) {
      failedActions += 1;
      console.error(
        "[user-sync] failed to update user subscription state:",
        "user=" + user.internalUuid,
        updateSubscriptionResult.error.message,
      );
      continue;
    }

    user.subscriptionActive = desiredState.subscriptionActive;
    user.subscriptionStatus = desiredState.subscriptionStatus;
    subscriptionStatusUpdatedUsers += 1;
  }

  const usersByInternalUuid = new Map(users.map((user) => [user.internalUuid, user]));
  const expiredUsers = users.filter((user) => isSubscriptionExpired(user, todayUtcStart));
  const expiredUserIds = new Set(expiredUsers.map((user) => user.internalUuid));
  const trialUnblockRestrictedUsers = users.filter(
    (user) =>
      !expiredUserIds.has(user.internalUuid) &&
      isTrialUnblockWindowExpired(user, nowMs, trialUnblockAccessHours),
  );

  const vpsResult = await supabase
    .from("vps")
    .select(
      'internal_uuid, api_address, domain, ssh_key, ssh_connection_key, "isUnblock", password, optional_passsword, users_kv_map, config_list, disabled, connection',
    );

  if (vpsResult.error !== null) {
    throw new Error("Failed to fetch vps rows for user-sync: " + vpsResult.error.message);
  }

  const vpsStates: UserSyncVpsState[] = vpsResult.data.map((rawRow) => {
    const row = userSyncVpsRowSchema.parse(rawRow);
    const usersKvMap = parseUsersKvMap(row.users_kv_map);
    return {
      row,
      usersKvMap,
      configList: row.config_list,
      sshConfig: null,
      resolveUserInternalUuid: buildLogMetricUserResolver(usersKvMap),
      liveUserIps: new Map<string, Set<string>>(),
      changed: false,
    };
  });

  let eligibleServersCount = 0;
  let successfulServersCount = 0;

  for (const vpsState of vpsStates) {
    if (vpsState.row.disabled === true || vpsState.row.connection === false) {
      continue;
    }

    eligibleServersCount += 1;

    try {
      const sshConfig = buildVpsSshConfig(vpsState.row);
      vpsState.sshConfig = sshConfig;
      const readLogsCommand = buildReadAccessLogsCommand(
        getXrayAccessLogPath(),
        getXrayLogTailLines(),
      );
      const logsResult = await runVpsSshCommandWithConfig(sshConfig, readLogsCommand);
      vpsState.liveUserIps = parseCurrentUserIpsFromLogs(
        logsResult.stdout,
        currentWindowMinutes,
        vpsState.resolveUserInternalUuid,
      );
      successfulServersCount += 1;

      if (verbose) {
        let serverUserCount = 0;
        let serverIpCount = 0;

        for (const userIps of vpsState.liveUserIps.values()) {
          serverUserCount += 1;
          serverIpCount += userIps.size;
        }

        console.log(
          "[user-sync][debug] live map from server:",
          "server=" + vpsState.row.internal_uuid,
          "domain=" + vpsState.row.domain,
          "users=" + String(serverUserCount),
          "ips=" + String(serverIpCount),
        );
      }
    } catch (error) {
      failedActions += 1;
      console.error(
        "[user-sync] failed to collect live user IPs from server:",
        "server=" + vpsState.row.internal_uuid,
        "domain=" + vpsState.row.domain,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const liveUserCurrentIps = new Map<string, Set<string>>();
  const liveConnectionsByServer = new Map<string, Record<string, number>>();

  for (const vpsState of vpsStates) {
    for (const [userInternalUuid, userIpsOnServer] of vpsState.liveUserIps.entries()) {
      const aggregateIps = liveUserCurrentIps.get(userInternalUuid) ?? new Set<string>();

      for (const ip of userIpsOnServer.values()) {
        aggregateIps.add(ip);
      }

      liveUserCurrentIps.set(userInternalUuid, aggregateIps);

      const previousConnectionsByServer = liveConnectionsByServer.get(userInternalUuid) ?? {};
      liveConnectionsByServer.set(userInternalUuid, {
        ...previousConnectionsByServer,
        [vpsState.row.internal_uuid]: userIpsOnServer.size,
      });
    }
  }

  const usersToUpdateConnectionStats = new Set<string>();
  const canResetMissingUsersToZero =
    eligibleServersCount > 0 && successfulServersCount === eligibleServersCount;

  for (const userInternalUuid of liveUserCurrentIps.keys()) {
    usersToUpdateConnectionStats.add(userInternalUuid);
  }

  if (canResetMissingUsersToZero) {
    for (const user of users) {
      if (expiredUserIds.has(user.internalUuid)) {
        continue;
      }

      if (user.numberOfConnections > 0 || Object.keys(user.connectionsByServer).length > 0) {
        usersToUpdateConnectionStats.add(user.internalUuid);
      }
    }
  }

  let connectionStatsUpdatedUsers = 0;
  const effectiveConnectionCountByUser = new Map<string, number>();

  for (const userInternalUuid of usersToUpdateConnectionStats.values()) {
    if (expiredUserIds.has(userInternalUuid)) {
      continue;
    }

    const existingUser = usersByInternalUuid.get(userInternalUuid);

    if (existingUser === undefined) {
      continue;
    }

    const nextCurrentIps = liveUserCurrentIps.get(userInternalUuid) ?? new Set<string>();
    const hasFreshLiveMap = liveUserCurrentIps.has(userInternalUuid);
    const nextConnectionsByServerRaw = liveConnectionsByServer.get(userInternalUuid) ?? {};
    const nextConnectionsByServer = hasFreshLiveMap
      ? nextConnectionsByServerRaw
      : canResetMissingUsersToZero
        ? {}
        : existingUser.connectionsByServer;
    const nextNumberOfConnections = hasFreshLiveMap
      ? nextCurrentIps.size
      : canResetMissingUsersToZero
        ? 0
        : existingUser.numberOfConnections;
    effectiveConnectionCountByUser.set(userInternalUuid, nextNumberOfConnections);
    const prevConnectionsByServer = existingUser.connectionsByServer;
    const sameConnectionCount = existingUser.numberOfConnections === nextNumberOfConnections;
    const prevKeys = Object.keys(prevConnectionsByServer).sort();
    const nextKeys = Object.keys(nextConnectionsByServer).sort();
    const sameMapShape = prevKeys.length === nextKeys.length;
    const sameMapValues =
      sameMapShape &&
      prevKeys.every(
        (key, index) =>
          key === nextKeys[index] && prevConnectionsByServer[key] === nextConnectionsByServer[key],
      );

    if (sameConnectionCount && sameMapValues) {
      continue;
    }

    const updateResult = await supabase
      .from("users")
      .update({
        number_of_connections: nextNumberOfConnections,
        connections_by_server: nextConnectionsByServer,
      })
      .eq("internal_uuid", userInternalUuid);

    if (updateResult.error !== null) {
      failedActions += 1;
      console.error(
        "[user-sync] failed to update user live connection stats:",
        "user=" + userInternalUuid,
        updateResult.error.message,
      );
      continue;
    }

    connectionStatsUpdatedUsers += 1;
  }

  const overLimitUsers = users.filter((user) => {
    if (expiredUserIds.has(user.internalUuid)) {
      return false;
    }

    const currentConnections = effectiveConnectionCountByUser.get(user.internalUuid);
    const resolvedCurrentConnections =
      currentConnections === undefined ? user.numberOfConnections : currentConnections;

    return resolvedCurrentConnections > userIpLimit;
  });

  let cleanedUsers = 0;
  let cleanedServers = 0;
  let trialUnblockCleanedServers = 0;
  let droppedUsers = 0;
  let droppedIps = 0;

  for (const user of expiredUsers) {
    let userCleaned = false;

    for (const vpsState of vpsStates) {
      if (!Object.hasOwn(vpsState.usersKvMap, user.internalUuid)) {
        continue;
      }

      const canRunSsh = vpsState.sshConfig !== null;
      let canRemoveFromDatabase = !canRunSsh;
      const trojanPasswords = extractTrojanPasswordsFromUsersKvEntry(
        vpsState.usersKvMap[user.internalUuid],
      );

      if (vpsState.sshConfig !== null) {
        try {
          await removeVpsXrayUserFromAllProtocols({
            sshConfig: vpsState.sshConfig,
            userInternalUuid: user.internalUuid,
            trojanPasswords,
          });

          const ports = extractVpsPorts(vpsState.configList);
          const knownIps = vpsState.liveUserIps.get(user.internalUuid) ?? new Set<string>();
          const droppedForUser =
            knownIps.size > 0
              ? await dropUserConnectionsByKnownIpsOnServer(vpsState.sshConfig, knownIps, ports)
              : await dropUserConnectionsOnServer(
                  vpsState.sshConfig,
                  user.internalUuid,
                  ports,
                  vpsState.resolveUserInternalUuid,
                );
          droppedIps += droppedForUser;
          canRemoveFromDatabase = true;

          if (verbose) {
            console.log(
              "[user-sync][debug] cleaned expired user on server:",
              "user=" + user.internalUuid,
              "server=" + vpsState.row.internal_uuid,
              "droppedIps=" + String(droppedForUser),
            );
          }
        } catch (error) {
          failedActions += 1;
          console.error(
            "[user-sync] failed to clean expired user on server:",
            "user=" + user.internalUuid,
            "server=" + vpsState.row.internal_uuid,
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      if (!canRemoveFromDatabase) {
        continue;
      }

      const removed = removeUserFromUsersKvMap(vpsState.usersKvMap, user.internalUuid);

      if (!removed.removed) {
        continue;
      }

      const nextConfigList = removeUrlsFromConfigList(vpsState.configList, removed.removedUrls);
      vpsState.usersKvMap = removed.nextUsersKvMap;
      vpsState.configList = nextConfigList;
      vpsState.changed = true;
      cleanedServers += 1;
      userCleaned = true;
    }

    const userPatch: Record<string, unknown> = {
      subscription_active: false,
      subscription_status: null,
      number_of_connections: 0,
      connections_by_server: {},
    };

    const updateUserResult = await supabase
      .from("users")
      .update(userPatch)
      .eq("internal_uuid", user.internalUuid);

    if (updateUserResult.error !== null) {
      failedActions += 1;
      console.error(
        "[user-sync] failed to update expired user status:",
        "user=" + user.internalUuid,
        updateUserResult.error.message,
      );
    }

    if (userCleaned) {
      cleanedUsers += 1;
    }
  }

  for (const user of trialUnblockRestrictedUsers) {
    for (const vpsState of vpsStates) {
      if (vpsState.row.isUnblock !== true) {
        continue;
      }

      if (!Object.hasOwn(vpsState.usersKvMap, user.internalUuid)) {
        continue;
      }

      const canRunSsh = vpsState.sshConfig !== null;
      let canRemoveFromDatabase = !canRunSsh;
      const trojanPasswords = extractTrojanPasswordsFromUsersKvEntry(
        vpsState.usersKvMap[user.internalUuid],
      );

      if (vpsState.sshConfig !== null) {
        try {
          await removeVpsXrayUserFromAllProtocols({
            sshConfig: vpsState.sshConfig,
            userInternalUuid: user.internalUuid,
            trojanPasswords,
          });

          const ports = extractVpsPorts(vpsState.configList);
          const knownIps = vpsState.liveUserIps.get(user.internalUuid) ?? new Set<string>();
          const droppedForUser =
            knownIps.size > 0
              ? await dropUserConnectionsByKnownIpsOnServer(vpsState.sshConfig, knownIps, ports)
              : await dropUserConnectionsOnServer(
                  vpsState.sshConfig,
                  user.internalUuid,
                  ports,
                  vpsState.resolveUserInternalUuid,
                );
          droppedIps += droppedForUser;
          canRemoveFromDatabase = true;

          if (verbose) {
            console.log(
              "[user-sync][debug] cleaned trial-unblock user on unblock server:",
              "user=" + user.internalUuid,
              "server=" + vpsState.row.internal_uuid,
              "droppedIps=" + String(droppedForUser),
            );
          }
        } catch (error) {
          failedActions += 1;
          console.error(
            "[user-sync] failed to clean trial-unblock user on server:",
            "user=" + user.internalUuid,
            "server=" + vpsState.row.internal_uuid,
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      if (!canRemoveFromDatabase) {
        continue;
      }

      const removed = removeUserFromUsersKvMap(vpsState.usersKvMap, user.internalUuid);

      if (!removed.removed) {
        continue;
      }

      const nextConfigList = removeUrlsFromConfigList(vpsState.configList, removed.removedUrls);
      vpsState.usersKvMap = removed.nextUsersKvMap;
      vpsState.configList = nextConfigList;
      vpsState.changed = true;
      trialUnblockCleanedServers += 1;
    }
  }

  for (const user of overLimitUsers) {
    let touchedServers = 0;
    let droppedForUser = 0;

    for (const vpsState of vpsStates) {
      if (!Object.hasOwn(vpsState.usersKvMap, user.internalUuid)) {
        continue;
      }

      if (vpsState.row.disabled === true || vpsState.row.connection === false) {
        continue;
      }

      if (vpsState.sshConfig === null) {
        continue;
      }

      try {
        const ports = extractVpsPorts(vpsState.configList);
        const knownIps = vpsState.liveUserIps.get(user.internalUuid) ?? new Set<string>();

        if (knownIps.size === 0) {
          continue;
        }

        const droppedOnServer = await dropUserConnectionsByKnownIpsOnServer(
          vpsState.sshConfig,
          knownIps,
          ports,
        );

        if (droppedOnServer > 0) {
          touchedServers += 1;
          droppedForUser += droppedOnServer;
        }
      } catch (error) {
        failedActions += 1;
        console.error(
          "[user-sync] failed to drop over-limit user connections:",
          "user=" + user.internalUuid,
          "server=" + vpsState.row.internal_uuid,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    if (droppedForUser > 0) {
      droppedUsers += 1;
      droppedIps += droppedForUser;

      const resetConnectionsResult = await supabase
        .from("users")
        .update({
          number_of_connections: 0,
          connections_by_server: {},
        })
        .eq("internal_uuid", user.internalUuid);

      if (resetConnectionsResult.error !== null) {
        failedActions += 1;
        console.error(
          "[user-sync] failed to reset over-limit user connection counters:",
          "user=" + user.internalUuid,
          resetConnectionsResult.error.message,
        );
      }
    }

    if (verbose && touchedServers > 0) {
      console.log(
        "[user-sync][debug] dropped over-limit user connections:",
        "user=" + user.internalUuid,
        "servers=" + String(touchedServers),
        "droppedIps=" + String(droppedForUser),
      );
    }
  }

  for (const vpsState of vpsStates) {
    if (!vpsState.changed) {
      continue;
    }

    const updateVpsResult = await supabase
      .from("vps")
      .update({
        users_kv_map: vpsState.usersKvMap,
        config_list: vpsState.configList,
      })
      .eq("internal_uuid", vpsState.row.internal_uuid);

    if (updateVpsResult.error !== null) {
      failedActions += 1;
      console.error(
        "[user-sync] failed to persist VPS cleanup update:",
        "server=" + vpsState.row.internal_uuid,
        updateVpsResult.error.message,
      );
    }
  }

  if (verbose) {
    console.log(
      "[user-sync][debug] run summary:",
      "users=" + String(users.length),
      "subscriptionStatusUpdatedUsers=" + String(subscriptionStatusUpdatedUsers),
      "expired=" + String(expiredUsers.length),
      "trialUnblockRestrictedUsers=" + String(trialUnblockRestrictedUsers.length),
      "trialUnblockCleanedServers=" + String(trialUnblockCleanedServers),
      "overLimit=" + String(overLimitUsers.length),
      "vps=" + String(vpsStates.length),
      "expiredSetSize=" + String(expiredUserIds.size),
      "connectionStatsUpdatedUsers=" + String(connectionStatsUpdatedUsers),
      "currentWindowMinutes=" + String(currentWindowMinutes),
      "serversEligible=" + String(eligibleServersCount),
      "serversLiveReadOk=" + String(successfulServersCount),
      "canResetMissingUsersToZero=" + String(canResetMissingUsersToZero),
    );
  }

  return {
    processedUsers: users.length,
    processedVps: vpsStates.length,
    subscriptionStatusUpdatedUsers,
    expiredUsers: expiredUsers.length,
    cleanedUsers,
    cleanedServers,
    trialUnblockRestrictedUsers: trialUnblockRestrictedUsers.length,
    trialUnblockCleanedServers,
    overLimitUsers: overLimitUsers.length,
    droppedUsers,
    droppedIps,
    connectionStatsUpdatedUsers,
    failedActions,
  };
}

async function runUserSyncSafely(trigger: string): Promise<void> {
  try {
    const result = await runUserSync();
    console.log(
      "[user-sync]",
      trigger,
      "processedUsers=" + String(result.processedUsers),
      "processedVps=" + String(result.processedVps),
      "subscriptionStatusUpdatedUsers=" + String(result.subscriptionStatusUpdatedUsers),
      "expiredUsers=" + String(result.expiredUsers),
      "cleanedUsers=" + String(result.cleanedUsers),
      "cleanedServers=" + String(result.cleanedServers),
      "trialUnblockRestrictedUsers=" + String(result.trialUnblockRestrictedUsers),
      "trialUnblockCleanedServers=" + String(result.trialUnblockCleanedServers),
      "overLimitUsers=" + String(result.overLimitUsers),
      "droppedUsers=" + String(result.droppedUsers),
      "droppedIps=" + String(result.droppedIps),
      "connectionStatsUpdatedUsers=" + String(result.connectionStatsUpdatedUsers),
      "failedActions=" + String(result.failedActions),
    );
  } catch (error) {
    console.error(
      "[user-sync]",
      trigger,
      "failed:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function startUserSyncJob(): void {
  if (!isUserSyncEnabled()) {
    console.log("[user-sync] disabled by USER_SYNC_ENABLED=false");
    return;
  }

  if (syncIntervalTimer !== null) {
    clearInterval(syncIntervalTimer);
    syncIntervalTimer = null;
  }

  const intervalMs = getUserSyncIntervalMs();
  const userIpLimit = getUserIpLimit();
  const trialUnblockAccessHours = getTrialUnblockAccessHours();
  const verbose = isVerboseUserSyncEnabled();

  console.log(
    "[user-sync] starting;",
    "intervalMs=" + String(intervalMs),
    "ipLimit=" + String(userIpLimit),
    "trialUnblockAccessHours=" + String(trialUnblockAccessHours),
    "verbose=" + String(verbose),
  );

  void runUserSyncSafely("startup");
  syncIntervalTimer = setInterval(() => {
    void runUserSyncSafely("interval");
  }, intervalMs);

  if (typeof syncIntervalTimer.unref === "function") {
    syncIntervalTimer.unref();
  }
}
