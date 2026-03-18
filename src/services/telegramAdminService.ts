import { z } from "zod";
import { getSupabaseAdminClient } from "../lib/supabaseAdmin";
import { findTelegramUserByNickname, getTelegramUserByTgId } from "./telegramUserService";
import { runVpsSshCommandWithConfig, type VpsSshConfig } from "./vpsSshService";
import { removeVpsXrayUserFromAllProtocols } from "./vpsXrayService";

const DEFAULT_XRAY_ACCESS_LOG_PATH = "/var/log/xray/access.log";
const DEFAULT_XRAY_ACCESS_LOG_TAIL_LINES = 5_000;
const DEFAULT_UNBLOCK_SSH_USER = "unluckypleasure";
const IPV4_PATTERN = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/gu;
const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu;

const adminUsersListRowSchema = z.object({
  internal_uuid: z.uuid(),
  tg_nickname: z.string().nullable(),
  tg_id: z.string().min(1),
  created_at: z.string().min(1),
  subscription_status: z.enum(["live", "ending"]).nullable(),
  subscription_untill: z.string().nullable(),
  number_of_connections: z.number().int().nonnegative(),
  isBanned: z.boolean().optional().default(false),
});

const adminVpsRowSchema = z.object({
  internal_uuid: z.uuid(),
  nickname: z.string().nullable(),
  country: z.string().min(1),
  country_emoji: z.string().min(1),
  api_address: z.string().min(1),
  number_of_connections: z.union([z.number(), z.string()]),
  domain: z.string().min(1),
  ssh_key: z.string().nullable().optional(),
  ssh_connection_key: z.string().nullable().optional(),
  isUnblock: z.boolean().nullable().optional(),
  password: z.string().nullable().optional(),
  optional_passsword: z.string().nullable(),
  config_list: z.array(z.string()),
  users_kv_map: z.unknown(),
  disabled: z.boolean().nullable().optional(),
  connection: z.boolean().nullable().optional(),
  current_speed: z.union([z.number(), z.string()]).nullable().optional(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

export interface AdminUsersPageItem {
  internalUuid: string;
  tgNickname: string | null;
  tgId: string;
  createdAt: string;
  subscriptionStatus: "live" | "ending" | null;
  subscriptionUntill: string | null;
  numberOfConnections: number;
  isBanned: boolean;
}

export interface AdminUsersPage {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  users: AdminUsersPageItem[];
}

export interface AdminUserConnectionsByServer {
  internalUuid: string;
  label: string;
  activeConnections: number;
}

export interface AdminUserDetails {
  internalUuid: string;
  tgNickname: string | null;
  tgId: string;
  trafficConsumedMb: number;
  subscriptionStatus: "live" | "ending" | null;
  subscriptionUntill: string | null;
  createdAt: string;
  earnedMoney: number;
  giftsCount: number;
  currentDiscount: number;
  hasPurchased: boolean;
  isBanned: boolean;
  numberOfConnections: number;
  connectedToServers: string[];
  connectionsByServer: AdminUserConnectionsByServer[];
}

export interface AdminVpsServer {
  internalUuid: string;
  nickname: string | null;
  country: string;
  countryEmoji: string;
  apiAddress: string;
  numberOfConnections: number;
  domain: string;
  sshKey: string | null;
  password: string | null;
  sshConnectionKey: string | null;
  isUnblock: boolean;
  optionalPasssword: string | null;
  disabled: boolean;
  connection: boolean;
  currentSpeed: number;
  configList: string[];
  usersKvMapKeys: string[];
  usersKvCount: number;
  createdAt: string;
  updatedAt: string;
}

interface ParsedVpsUserKvEntry {
  directUrl?: string;
  obfsUrl?: string;
  protocolUrls: string[];
}

function parseAdminUsersListRow(rawRow: unknown): z.infer<typeof adminUsersListRowSchema> {
  return adminUsersListRowSchema.parse(rawRow);
}

function parseAdminVpsRow(rawRow: unknown): z.infer<typeof adminVpsRowSchema> {
  return adminVpsRowSchema.parse(rawRow);
}

function parseNonNegativeInteger(rawValue: number | string): number {
  const parsed = typeof rawValue === "number" ? rawValue : Number.parseInt(rawValue.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return Math.floor(parsed);
}

function parseNonNegativeFloat(rawValue: number | string | null | undefined): number {
  if (rawValue === null || rawValue === undefined) {
    return 0;
  }

  const parsed = typeof rawValue === "number" ? rawValue : Number.parseFloat(rawValue.trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return Math.round(parsed * 100) / 100;
}

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

function getUnblockSshUser(): string {
  const rawUser = process.env.VPS_UNBLOCK_SSH_USER?.trim();
  return rawUser !== undefined && rawUser.length > 0 ? rawUser : DEFAULT_UNBLOCK_SSH_USER;
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

function buildVpsSshConfig(row: z.infer<typeof adminVpsRowSchema>): VpsSshConfig {
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

function parseUsersKvMapLoose(rawValue: unknown): Partial<Record<string, ParsedVpsUserKvEntry>> {
  if (typeof rawValue !== "object" || rawValue === null || Array.isArray(rawValue)) {
    return {};
  }

  const nextEntries: Partial<Record<string, ParsedVpsUserKvEntry>> = {};

  for (const [key, value] of Object.entries(rawValue)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }

    const entry = value as Record<string, unknown>;
    const parsedEntry: ParsedVpsUserKvEntry = {
      protocolUrls: [],
    };

    if (typeof entry.directUrl === "string" && entry.directUrl.length > 0) {
      parsedEntry.directUrl = entry.directUrl;
      parsedEntry.protocolUrls.push(entry.directUrl);
    }

    if (typeof entry.obfsUrl === "string" && entry.obfsUrl.length > 0) {
      parsedEntry.obfsUrl = entry.obfsUrl;
      parsedEntry.protocolUrls.push(entry.obfsUrl);
    }

    if (
      typeof entry.protocols === "object" &&
      entry.protocols !== null &&
      !Array.isArray(entry.protocols)
    ) {
      for (const protocolEntry of Object.values(entry.protocols as Record<string, unknown>)) {
        if (
          typeof protocolEntry !== "object" ||
          protocolEntry === null ||
          Array.isArray(protocolEntry)
        ) {
          continue;
        }

        const url = (protocolEntry as Record<string, unknown>).url;

        if (typeof url === "string" && url.length > 0) {
          parsedEntry.protocolUrls.push(url);
        }
      }
    }

    if (parsedEntry.protocolUrls.length > 1) {
      parsedEntry.protocolUrls = Array.from(new Set(parsedEntry.protocolUrls));
    }

    nextEntries[key] = parsedEntry;
  }

  return nextEntries;
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

function parseUserIpsFromLogs(logOutput: string, userInternalUuid: string): string[] {
  const normalizedUserUuid = userInternalUuid.toLowerCase();
  const ips = new Set<string>();

  for (const line of logOutput.split(/\r?\n/u)) {
    const lineUuidMatch = line.match(UUID_PATTERN);

    if (lineUuidMatch === null || lineUuidMatch[0].toLowerCase() !== normalizedUserUuid) {
      continue;
    }

    const ipMatches = line.match(IPV4_PATTERN);

    if (ipMatches === null) {
      continue;
    }

    for (const ip of ipMatches) {
      ips.add(ip);
    }
  }

  return Array.from(ips.values());
}

function extractVpsPorts(configList: string[]): number[] {
  const ports = new Set<number>();

  for (const configUrl of configList) {
    try {
      const parsedUrl = new URL(configUrl);
      const parsedPort = Number.parseInt(parsedUrl.port, 10);

      if (Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
        ports.add(parsedPort);
      }
    } catch {
      continue;
    }
  }

  return Array.from(ports.values());
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

function buildKillAllConnectionsByPortsCommand(ports: number[]): string {
  if (ports.length === 0) {
    return "true";
  }

  const statements = ports
    .map(
      (port) =>
        "ss -K dport = :" +
        String(port) +
        " 2>/dev/null || true; ss -K sport = :" +
        String(port) +
        " 2>/dev/null || true",
    )
    .join("; ");

  return "if command -v ss >/dev/null 2>&1; then " + statements + "; else true; fi";
}

async function disconnectUserConnectionsOnServer(
  sshConfig: VpsSshConfig,
  userInternalUuid: string,
  ports: number[],
): Promise<number> {
  const readLogsCommand = buildReadAccessLogsCommand(getXrayAccessLogPath(), getXrayLogTailLines());
  const logsResult = await runVpsSshCommandWithConfig(sshConfig, readLogsCommand);
  const userIps = parseUserIpsFromLogs(logsResult.stdout, userInternalUuid);

  if (userIps.length === 0) {
    return 0;
  }

  const dropCommand = buildDropUserConnectionsCommand(userIps, ports);
  await runVpsSshCommandWithConfig(sshConfig, dropCommand);
  return userIps.length;
}

function buildDisableXrayServerCommand(ports: number[]): string {
  const killByPortsCommand = buildKillAllConnectionsByPortsCommand(ports);
  return (
    "set -eu; " +
    killByPortsCommand +
    "; " +
    "if command -v systemctl >/dev/null 2>&1; then " +
    "systemctl stop xray || true; systemctl disable xray || true; " +
    "elif command -v service >/dev/null 2>&1; then " +
    "service xray stop || true; " +
    "else " +
    "pkill -f xray || true; " +
    "fi"
  );
}

function buildEnableXrayServerCommand(): string {
  return (
    "set -eu; " +
    "if command -v systemctl >/dev/null 2>&1; then " +
    "systemctl enable xray || true; " +
    "systemctl start xray || systemctl restart xray; " +
    "systemctl restart xray || true; " +
    "systemctl is-active xray >/dev/null; " +
    "elif command -v service >/dev/null 2>&1; then " +
    "service xray start || service xray restart; " +
    "else " +
    "pkill -HUP xray || true; " +
    "fi"
  );
}

function buildReloadXrayServerCommand(): string {
  return (
    "set -eu; " +
    "if command -v systemctl >/dev/null 2>&1; then " +
    "systemctl reload xray || systemctl restart xray; " +
    "systemctl is-active xray >/dev/null; " +
    "elif command -v service >/dev/null 2>&1; then " +
    "service xray reload || service xray restart; " +
    "else " +
    "pkill -HUP xray || true; " +
    "fi"
  );
}

function removeUserUrlsFromConfigList(
  configList: string[],
  entry: ParsedVpsUserKvEntry | undefined,
): { nextConfigList: string[]; changed: boolean } {
  if (entry === undefined) {
    return {
      nextConfigList: configList,
      changed: false,
    };
  }

  const blocked = new Set<string>();

  for (const protocolUrl of entry.protocolUrls) {
    blocked.add(protocolUrl);
  }

  if (entry.directUrl !== undefined) {
    blocked.add(entry.directUrl);
  }

  if (entry.obfsUrl !== undefined) {
    blocked.add(entry.obfsUrl);
  }

  if (blocked.size === 0) {
    return {
      nextConfigList: configList,
      changed: false,
    };
  }

  const nextConfigList = configList.filter((url) => !blocked.has(url));
  return {
    nextConfigList,
    changed: nextConfigList.length !== configList.length,
  };
}

async function fetchAllAdminVpsRows(): Promise<Array<z.infer<typeof adminVpsRowSchema>>> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("vps")
    .select(
      'internal_uuid, nickname, country, country_emoji, api_address, number_of_connections, domain, ssh_key, ssh_connection_key, "isUnblock", password, optional_passsword, config_list, users_kv_map, disabled, connection, current_speed, created_at, updated_at',
    )
    .order("country", { ascending: true })
    .order("nickname", { ascending: true });

  if (error !== null) {
    throw new Error("Failed to fetch VPS rows for admin panel: " + error.message);
  }

  return data.map((rawRow) => parseAdminVpsRow(rawRow));
}

async function fetchAdminVpsRowByInternalUuid(
  internalUuid: string,
): Promise<z.infer<typeof adminVpsRowSchema> | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("vps")
    .select(
      'internal_uuid, nickname, country, country_emoji, api_address, number_of_connections, domain, ssh_key, ssh_connection_key, "isUnblock", password, optional_passsword, config_list, users_kv_map, disabled, connection, current_speed, created_at, updated_at',
    )
    .eq("internal_uuid", internalUuid)
    .maybeSingle();

  if (error !== null) {
    throw new Error("Failed to fetch VPS row by internal_uuid: " + error.message);
  }

  if (data === null) {
    return null;
  }

  return parseAdminVpsRow(data);
}

async function updateVpsRowByInternalUuid(
  internalUuid: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const { error } = await supabase.from("vps").update(patch).eq("internal_uuid", internalUuid);

  if (error !== null) {
    throw new Error("Failed to update VPS row: " + error.message);
  }
}

export async function listAdminUsersPage(page: number, pageSize = 10): Promise<AdminUsersPage> {
  const safePageSize = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : 10;
  const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;

  const supabase = getSupabaseAdminClient();

  async function fetchPage(pageNumber: number): Promise<{
    rows: z.infer<typeof adminUsersListRowSchema>[];
    totalCount: number;
  }> {
    const from = (pageNumber - 1) * safePageSize;
    const to = from + safePageSize - 1;
    const { data, error, count } = await supabase
      .from("users")
      .select(
        'internal_uuid, tg_nickname, tg_id, created_at, subscription_status, subscription_untill, number_of_connections, "isBanned"',
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .range(from, to);

    if (error !== null) {
      throw new Error("Failed to fetch users page for admin panel: " + error.message);
    }

    const rows = data.map((rawRow) => parseAdminUsersListRow(rawRow));
    return {
      rows,
      totalCount: count ?? 0,
    };
  }

  let currentPage = normalizedPage;
  let fetched = await fetchPage(currentPage);
  let totalPages = Math.max(1, Math.ceil(fetched.totalCount / safePageSize));

  if (currentPage > totalPages) {
    currentPage = totalPages;
    fetched = await fetchPage(currentPage);
    totalPages = Math.max(1, Math.ceil(fetched.totalCount / safePageSize));
  }

  return {
    page: currentPage,
    pageSize: safePageSize,
    totalCount: fetched.totalCount,
    totalPages,
    users: fetched.rows.map((row) => ({
      internalUuid: row.internal_uuid,
      tgNickname: row.tg_nickname,
      tgId: row.tg_id,
      createdAt: row.created_at,
      subscriptionStatus: row.subscription_status,
      subscriptionUntill: row.subscription_untill,
      numberOfConnections: row.number_of_connections,
      isBanned: row.isBanned,
    })),
  };
}

export async function getAdminUserDetailsByTgId(tgId: string): Promise<AdminUserDetails | null> {
  const user = await getTelegramUserByTgId(tgId);

  if (user === null) {
    return null;
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("vps")
    .select("internal_uuid, nickname, country, country_emoji, users_kv_map");

  if (error !== null) {
    throw new Error("Failed to fetch VPS rows for user details: " + error.message);
  }

  const serverLabelByInternalUuid = new Map<string, string>();
  const connectedToServers: string[] = [];

  for (const rawRow of data) {
    const row = rawRow as Record<string, unknown>;
    const internalUuid = typeof row.internal_uuid === "string" ? row.internal_uuid : null;
    const country = typeof row.country === "string" ? row.country : "UNKNOWN";
    const countryEmoji = typeof row.country_emoji === "string" ? row.country_emoji : "";
    const nickname =
      typeof row.nickname === "string" && row.nickname.length > 0 ? row.nickname : null;

    if (internalUuid === null) {
      continue;
    }

    const label =
      (nickname ?? "VPS " + internalUuid.slice(0, 8).toUpperCase()) +
      " (" +
      countryEmoji +
      " " +
      country +
      ")";
    serverLabelByInternalUuid.set(internalUuid, label);

    const usersKvMap = parseUsersKvMapLoose(row.users_kv_map);
    if (Object.hasOwn(usersKvMap, user.internal_uuid)) {
      connectedToServers.push(label);
    }
  }

  const connectionsByServer = Object.entries(user.connections_by_server)
    .filter(([, value]) => Number.isFinite(value) && value > 0)
    .map(([internalUuid, activeConnections]) => ({
      internalUuid,
      label:
        serverLabelByInternalUuid.get(internalUuid) ??
        "VPS " + internalUuid.slice(0, 8).toUpperCase(),
      activeConnections: Math.floor(activeConnections),
    }));

  return {
    internalUuid: user.internal_uuid,
    tgNickname: user.tg_nickname,
    tgId: user.tg_id,
    trafficConsumedMb: user.traffic_consumed_mb,
    subscriptionStatus: user.subscription_status,
    subscriptionUntill: user.subscription_untill,
    createdAt: user.created_at,
    earnedMoney: user.earned_money,
    giftsCount: user.gifts.length,
    currentDiscount: user.current_discount,
    hasPurchased: user.has_purchased,
    isBanned: user.isBanned,
    numberOfConnections: user.number_of_connections,
    connectedToServers,
    connectionsByServer,
  };
}

async function resolveUserByNickname(
  nickname: string,
): Promise<NonNullable<Awaited<ReturnType<typeof findTelegramUserByNickname>>>> {
  const user = await findTelegramUserByNickname(nickname);

  if (user === null) {
    throw new Error("USER_NOT_FOUND");
  }

  return user;
}

async function markUserBannedByInternalUuid(
  internalUuid: string,
  isBanned: boolean,
): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const { error } = await supabase
    .from("users")
    .update({
      isBanned,
      connections_by_server: {},
      number_of_connections: 0,
    })
    .eq("internal_uuid", internalUuid);

  if (error !== null) {
    throw new Error("Failed to update user ban status: " + error.message);
  }
}

export async function banTelegramUserByNickname(input: {
  nickname: string;
}): Promise<{ userTgId: string; disconnectedIps: number; touchedServers: number }> {
  const user = await resolveUserByNickname(input.nickname);

  if (user.isAdmin) {
    throw new Error("CANNOT_BAN_ADMIN");
  }

  const vpsRows = await fetchAllAdminVpsRows();
  let disconnectedIps = 0;
  let touchedServers = 0;

  for (const row of vpsRows) {
    const rawUsersKvMap =
      typeof row.users_kv_map === "object" &&
      row.users_kv_map !== null &&
      !Array.isArray(row.users_kv_map)
        ? (row.users_kv_map as Record<string, unknown>)
        : {};
    const usersKvMap = parseUsersKvMapLoose(rawUsersKvMap);
    const existingEntry = usersKvMap[user.internal_uuid];
    const hadUserInKvMap = Object.hasOwn(rawUsersKvMap, user.internal_uuid);
    const nextUsersKvMap = Object.fromEntries(
      Object.entries(rawUsersKvMap).filter(([entryKey]) => entryKey !== user.internal_uuid),
    );

    const removedFromConfigList = removeUserUrlsFromConfigList(row.config_list, existingEntry);

    if (row.disabled !== true && row.connection !== false) {
      const sshConfig = buildVpsSshConfig(row);
      const ports = extractVpsPorts(row.config_list);
      disconnectedIps += await disconnectUserConnectionsOnServer(
        sshConfig,
        user.internal_uuid,
        ports,
      );
      await removeVpsXrayUserFromAllProtocols({
        sshConfig,
        userInternalUuid: user.internal_uuid,
      });
    }

    if (hadUserInKvMap || removedFromConfigList.changed) {
      await updateVpsRowByInternalUuid(row.internal_uuid, {
        users_kv_map: nextUsersKvMap,
        config_list: removedFromConfigList.nextConfigList,
      });
      touchedServers += 1;
    }
  }

  await markUserBannedByInternalUuid(user.internal_uuid, true);

  return {
    userTgId: user.tg_id,
    disconnectedIps,
    touchedServers,
  };
}

export async function unbanTelegramUserByNickname(input: {
  nickname: string;
}): Promise<{ userTgId: string }> {
  const user = await resolveUserByNickname(input.nickname);

  const supabase = getSupabaseAdminClient();
  const { error } = await supabase
    .from("users")
    .update({ isBanned: false })
    .eq("internal_uuid", user.internal_uuid);

  if (error !== null) {
    throw new Error("Failed to unban user: " + error.message);
  }

  return {
    userTgId: user.tg_id,
  };
}

export async function disconnectTelegramUserConnectionsByNickname(input: {
  nickname: string;
}): Promise<{ userTgId: string; disconnectedIps: number; touchedServers: number }> {
  const user = await resolveUserByNickname(input.nickname);
  const vpsRows = await fetchAllAdminVpsRows();
  let disconnectedIps = 0;
  let touchedServers = 0;

  for (const row of vpsRows) {
    if (row.disabled === true || row.connection === false) {
      continue;
    }

    const usersKvMap = parseUsersKvMapLoose(row.users_kv_map);
    if (!Object.hasOwn(usersKvMap, user.internal_uuid)) {
      continue;
    }

    const sshConfig = buildVpsSshConfig(row);
    const ports = extractVpsPorts(row.config_list);
    disconnectedIps += await disconnectUserConnectionsOnServer(
      sshConfig,
      user.internal_uuid,
      ports,
    );
    touchedServers += 1;
  }

  const supabase = getSupabaseAdminClient();
  const { error } = await supabase
    .from("users")
    .update({
      number_of_connections: 0,
      connections_by_server: {},
    })
    .eq("internal_uuid", user.internal_uuid);

  if (error !== null) {
    throw new Error("Failed to reset user current connection stats: " + error.message);
  }

  return {
    userTgId: user.tg_id,
    disconnectedIps,
    touchedServers,
  };
}

function mapAdminVpsRow(row: z.infer<typeof adminVpsRowSchema>): AdminVpsServer {
  const usersKvMap = parseUsersKvMapLoose(row.users_kv_map);

  return {
    internalUuid: row.internal_uuid,
    nickname: row.nickname,
    country: row.country,
    countryEmoji: row.country_emoji,
    apiAddress: row.api_address,
    numberOfConnections: parseNonNegativeInteger(row.number_of_connections),
    domain: row.domain,
    sshKey: row.ssh_key ?? null,
    password: row.password ?? null,
    sshConnectionKey: row.ssh_connection_key ?? null,
    isUnblock: row.isUnblock === true,
    optionalPasssword: row.optional_passsword,
    disabled: row.disabled === true,
    connection: row.connection === true,
    currentSpeed: parseNonNegativeFloat(row.current_speed),
    configList: row.config_list,
    usersKvMapKeys: Object.keys(usersKvMap),
    usersKvCount: Object.keys(usersKvMap).length,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listAdminVpsServers(): Promise<AdminVpsServer[]> {
  const rows = await fetchAllAdminVpsRows();
  return rows.map((row) => mapAdminVpsRow(row));
}

export async function getAdminVpsServerByInternalUuid(
  internalUuid: string,
): Promise<AdminVpsServer | null> {
  const row = await fetchAdminVpsRowByInternalUuid(internalUuid);

  if (row === null) {
    return null;
  }

  return mapAdminVpsRow(row);
}

export async function disableAdminVpsServer(internalUuid: string): Promise<AdminVpsServer> {
  const row = await fetchAdminVpsRowByInternalUuid(internalUuid);

  if (row === null) {
    throw new Error("SERVER_NOT_FOUND");
  }

  const sshConfig = buildVpsSshConfig(row);
  const ports = extractVpsPorts(row.config_list);
  await runVpsSshCommandWithConfig(sshConfig, buildDisableXrayServerCommand(ports));
  await updateVpsRowByInternalUuid(row.internal_uuid, {
    disabled: true,
    connection: false,
    number_of_connections: 0,
    current_speed: 0,
  });

  const refreshed = await getAdminVpsServerByInternalUuid(row.internal_uuid);

  if (refreshed === null) {
    throw new Error("SERVER_NOT_FOUND");
  }

  return refreshed;
}

export async function enableAdminVpsServer(internalUuid: string): Promise<AdminVpsServer> {
  const row = await fetchAdminVpsRowByInternalUuid(internalUuid);

  if (row === null) {
    throw new Error("SERVER_NOT_FOUND");
  }

  const sshConfig = buildVpsSshConfig(row);
  await runVpsSshCommandWithConfig(sshConfig, buildEnableXrayServerCommand());
  await updateVpsRowByInternalUuid(row.internal_uuid, {
    disabled: false,
    connection: true,
  });

  const refreshed = await getAdminVpsServerByInternalUuid(row.internal_uuid);

  if (refreshed === null) {
    throw new Error("SERVER_NOT_FOUND");
  }

  return refreshed;
}

export async function reloadAdminVpsServer(internalUuid: string): Promise<AdminVpsServer> {
  const row = await fetchAdminVpsRowByInternalUuid(internalUuid);

  if (row === null) {
    throw new Error("SERVER_NOT_FOUND");
  }

  const sshConfig = buildVpsSshConfig(row);
  await runVpsSshCommandWithConfig(sshConfig, buildReloadXrayServerCommand());
  await updateVpsRowByInternalUuid(row.internal_uuid, {
    disabled: false,
    connection: true,
  });

  const refreshed = await getAdminVpsServerByInternalUuid(row.internal_uuid);

  if (refreshed === null) {
    throw new Error("SERVER_NOT_FOUND");
  }

  return refreshed;
}
