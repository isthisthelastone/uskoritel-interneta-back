import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { getSupabaseAdminClient } from "../lib/supabaseAdmin";
import { ensureVpsXrayClient } from "./vpsXrayService";
import type { VpsSshConfig } from "./vpsSshService";

export const vpsConfigProtocolSchema = z.enum([
  "trojan",
  "trojan_obfuscated",
  "vless_ws",
  "shadowsocks",
]);
export type VpsConfigProtocol = z.infer<typeof vpsConfigProtocolSchema>;

const DEFAULT_TROJAN_DIRECT_PORT = 443;
const DEFAULT_TROJAN_OBFS_PORT = 9000;
const DEFAULT_UNBLOCK_SSH_USER = "unluckypleasure";

const vpsCountryRowSchema = z.object({
  internal_uuid: z.uuid(),
  country: z.string().min(1),
  country_emoji: z.string().min(1),
});

const vpsByCountryRowSchema = z.object({
  internal_uuid: z.uuid(),
  nickname: z.string().nullable(),
  country: z.string().min(1),
  country_emoji: z.string().min(1),
  isUnblock: z.boolean().nullable().optional(),
  current_speed: z.union([z.number(), z.string()]).nullable().optional(),
  number_of_connections: z.union([z.number(), z.string()]).nullable().optional(),
});

const vpsConfigRowSchema = z.object({
  nickname: z.string().nullable(),
  config_list: z.array(z.string()),
  users_kv_map: z.unknown(),
});

const vpsIssueConfigRowSchema = vpsConfigRowSchema.extend({
  api_address: z.string().min(1),
  password: z.string().nullable().optional(),
  ssh_key: z.string().nullable().optional(),
  ssh_connection_key: z.string().nullable().optional(),
  isUnblock: z.boolean().nullable().optional(),
  optional_passsword: z.string().nullable(),
  disabled: z.boolean().nullable().optional(),
});

const vpsRouteRowSchema = z.object({
  internal_uuid: z.uuid(),
  nickname: z.string().nullable(),
  country_emoji: z.string().min(1),
  disabled: z.boolean().nullable().optional(),
  isUnblock: z.boolean().nullable().optional(),
});

const vpsUserProtocolCredentialEntrySchema = z.object({
  secretBase64: z.string().min(1),
  url: z.string().min(1),
  createdAt: z.string().min(1),
  active: z.boolean().optional(),
});

const vpsUserProtocolsSchema = z
  .object({
    trojan: vpsUserProtocolCredentialEntrySchema.optional(),
    trojan_obfuscated: vpsUserProtocolCredentialEntrySchema.optional(),
    vless_ws: vpsUserProtocolCredentialEntrySchema.optional(),
    shadowsocks: vpsUserProtocolCredentialEntrySchema.optional(),
  })
  .partial();

const vpsUserCredentialEntrySchema = z.object({
  createdAt: z.string().optional(),
  active: z.boolean().optional(),
  protocols: vpsUserProtocolsSchema.optional(),
  passwordBase64: z.string().optional(),
  directUrl: z.string().optional(),
  obfsUrl: z.string().optional(),
});

type VpsUserProtocolCredentialEntry = z.infer<typeof vpsUserProtocolCredentialEntrySchema>;

interface VpsUserCredentialEntry {
  createdAt: string;
  active?: boolean;
  protocols: Partial<Record<VpsConfigProtocol, VpsUserProtocolCredentialEntry>>;
}

export interface VpsCountryOption {
  internalUuid: string;
  country: string;
  countryEmoji: string;
}

export interface VpsByCountryOption {
  internalUuid: string;
  nickname: string | null;
  country: string;
  countryEmoji: string;
  isUnblock: boolean;
  currentSpeed: number;
  numberOfConnections: number;
}

export interface VpsRouteInfo {
  internalUuid: string;
  nickname: string | null;
  countryEmoji: string;
  isUnblock: boolean;
}

export interface VpsConfigDetails {
  nickname: string | null;
  configList: string[];
}

export interface VpsUserConfigUrl {
  nickname: string;
  protocol: VpsConfigProtocol;
  url: string;
  created: boolean;
}

export interface VpsUserConfigUrls {
  nickname: string;
  directUrl: string;
  obfsUrl: string;
  created: boolean;
}

function parseVpsCountryRow(rawRow: unknown): z.infer<typeof vpsCountryRowSchema> {
  return vpsCountryRowSchema.parse(rawRow);
}

function parseVpsByCountryRow(rawRow: unknown): z.infer<typeof vpsByCountryRowSchema> {
  return vpsByCountryRowSchema.parse(rawRow);
}

function parseNonNegativeNumberOrZero(rawValue: string | number | null | undefined): number {
  if (rawValue === null || rawValue === undefined) {
    return 0;
  }

  const parsedValue = typeof rawValue === "number" ? rawValue : Number.parseFloat(rawValue.trim());

  if (!Number.isFinite(parsedValue) || parsedValue < 0) {
    return 0;
  }

  return parsedValue;
}

function parseVpsConfigRow(rawRow: unknown): z.infer<typeof vpsConfigRowSchema> {
  return vpsConfigRowSchema.parse(rawRow);
}

function parseVpsIssueConfigRow(rawRow: unknown): z.infer<typeof vpsIssueConfigRowSchema> {
  return vpsIssueConfigRowSchema.parse(rawRow);
}

function parseVpsRouteRow(rawRow: unknown): z.infer<typeof vpsRouteRowSchema> {
  return vpsRouteRowSchema.parse(rawRow);
}

function parseUsersKvMap(rawValue: unknown): Partial<Record<string, VpsUserCredentialEntry>> {
  if (typeof rawValue !== "object" || rawValue === null || Array.isArray(rawValue)) {
    return {};
  }

  const nextEntries: Partial<Record<string, VpsUserCredentialEntry>> = {};

  for (const [entryKey, entryValue] of Object.entries(rawValue)) {
    const parsedEntry = vpsUserCredentialEntrySchema.safeParse(entryValue);

    if (!parsedEntry.success) {
      continue;
    }

    const normalizedProtocols: Partial<Record<VpsConfigProtocol, VpsUserProtocolCredentialEntry>> =
      {};

    if (parsedEntry.data.protocols !== undefined) {
      for (const protocol of vpsConfigProtocolSchema.options) {
        const protocolEntry = parsedEntry.data.protocols[protocol];

        if (protocolEntry !== undefined) {
          normalizedProtocols[protocol] = protocolEntry;
        }
      }
    }

    if (
      parsedEntry.data.passwordBase64 !== undefined &&
      parsedEntry.data.directUrl !== undefined &&
      normalizedProtocols.trojan === undefined
    ) {
      normalizedProtocols.trojan = {
        secretBase64: parsedEntry.data.passwordBase64,
        url: parsedEntry.data.directUrl,
        createdAt: parsedEntry.data.createdAt ?? new Date(0).toISOString(),
        active: parsedEntry.data.active,
      };
    }

    if (
      parsedEntry.data.passwordBase64 !== undefined &&
      parsedEntry.data.obfsUrl !== undefined &&
      normalizedProtocols.trojan_obfuscated === undefined
    ) {
      normalizedProtocols.trojan_obfuscated = {
        secretBase64: parsedEntry.data.passwordBase64,
        url: parsedEntry.data.obfsUrl,
        createdAt: parsedEntry.data.createdAt ?? new Date(0).toISOString(),
        active: parsedEntry.data.active,
      };
    }

    if (Object.keys(normalizedProtocols).length === 0) {
      continue;
    }

    const firstProtocolCreatedAt = Object.values(normalizedProtocols)[0].createdAt;
    const fallbackCreatedAt = parsedEntry.data.createdAt ?? firstProtocolCreatedAt;

    nextEntries[entryKey] = {
      createdAt: fallbackCreatedAt,
      active: parsedEntry.data.active,
      protocols: normalizedProtocols,
    };
  }

  return nextEntries;
}

function serializeUsersKvMapEntry(entry: VpsUserCredentialEntry): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    createdAt: entry.createdAt,
    active: entry.active ?? true,
    protocols: entry.protocols,
  };

  const directEntry = entry.protocols.trojan;
  const obfsEntry = entry.protocols.trojan_obfuscated;

  if (directEntry !== undefined) {
    serialized.passwordBase64 = directEntry.secretBase64;
    serialized.directUrl = directEntry.url;
  }

  if (obfsEntry !== undefined) {
    if (serialized.passwordBase64 === undefined) {
      serialized.passwordBase64 = obfsEntry.secretBase64;
    }
    serialized.obfsUrl = obfsEntry.url;
  }

  return serialized;
}

function serializeUsersKvMap(
  map: Partial<Record<string, VpsUserCredentialEntry>>,
): Record<string, unknown> {
  const nextMap: Record<string, unknown> = {};

  for (const [userInternalUuid, entry] of Object.entries(map)) {
    if (entry === undefined) {
      continue;
    }

    if (Object.keys(entry.protocols).length === 0) {
      continue;
    }

    nextMap[userInternalUuid] = serializeUsersKvMapEntry(entry);
  }

  return nextMap;
}

function buildGeneratedSecret(protocol: VpsConfigProtocol): string {
  if (protocol === "vless_ws") {
    return randomUUID();
  }

  return randomBytes(18).toString("base64url");
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

function decodeBase64Strict(rawValue: string): string {
  const decoded = Buffer.from(rawValue, "base64").toString("utf8");

  if (decoded.length === 0) {
    throw new Error("Stored user secretBase64 is invalid.");
  }

  return decoded;
}

function normalizeBase64ForDecode(rawValue: string): string {
  let normalized = rawValue.replaceAll("-", "+").replaceAll("_", "/");
  const rest = normalized.length % 4;

  if (rest > 0) {
    normalized += "=".repeat(4 - rest);
  }

  return normalized;
}

function decodeBase64Flexible(rawValue: string): string | null {
  try {
    const decoded = Buffer.from(normalizeBase64ForDecode(rawValue), "base64").toString("utf8");
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

function tryParseUrl(configUrl: string): URL | null {
  try {
    return new URL(configUrl);
  } catch {
    return null;
  }
}

function parseSchemeFromConfigUrl(configUrl: string): string | null {
  const parsed = tryParseUrl(configUrl);

  if (parsed !== null) {
    return parsed.protocol.toLowerCase().replace(/:$/u, "");
  }

  if (configUrl.startsWith("trojan://")) {
    return "trojan";
  }

  if (configUrl.startsWith("vless://")) {
    return "vless";
  }

  if (configUrl.startsWith("ss://")) {
    return "ss";
  }

  return null;
}

function parsePortFromConfigUrl(configUrl: string): number | null {
  const parsed = tryParseUrl(configUrl);

  if (parsed === null) {
    return null;
  }

  if (parsed.port.length === 0) {
    return null;
  }

  const parsedPort = Number.parseInt(parsed.port, 10);

  if (!Number.isFinite(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    return null;
  }

  return parsedPort;
}

function parseLabelFromConfigUrl(configUrl: string): string {
  const parsed = tryParseUrl(configUrl);

  if (parsed !== null) {
    return decodeURIComponent(parsed.hash.replace(/^#/u, "")).toUpperCase();
  }

  const hashIndex = configUrl.lastIndexOf("#");

  if (hashIndex < 0 || hashIndex === configUrl.length - 1) {
    return "";
  }

  return decodeURIComponent(configUrl.slice(hashIndex + 1)).toUpperCase();
}

function isObfuscatedTrojanTemplate(configUrl: string): boolean {
  const normalizedLabel = parseLabelFromConfigUrl(configUrl);
  const normalizedUrl = configUrl.toUpperCase();

  return (
    normalizedLabel.includes("OBF") ||
    normalizedLabel.includes("OBFUSCATED") ||
    normalizedUrl.includes("OBF") ||
    normalizedUrl.includes("OBFUSCATED")
  );
}

function getTrojanDirectPort(): number {
  const parsed = Number.parseInt(process.env.XRAY_TROJAN_DIRECT_PORT ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535
    ? parsed
    : DEFAULT_TROJAN_DIRECT_PORT;
}

function getTrojanObfsPort(): number {
  const parsed = Number.parseInt(process.env.XRAY_TROJAN_OBFS_PORT ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535
    ? parsed
    : DEFAULT_TROJAN_OBFS_PORT;
}

function getUnblockSshUser(): string {
  const rawUser = process.env.VPS_UNBLOCK_SSH_USER?.trim();
  return rawUser !== undefined && rawUser.length > 0 ? rawUser : DEFAULT_UNBLOCK_SSH_USER;
}

function pickTemplateForProtocol(configList: string[], protocol: VpsConfigProtocol): string {
  if (configList.length === 0) {
    throw new Error("VPS config_list is empty.");
  }

  if (protocol === "trojan" || protocol === "trojan_obfuscated") {
    const trojanTemplates = configList.filter((url) => parseSchemeFromConfigUrl(url) === "trojan");

    if (trojanTemplates.length === 0) {
      throw new Error("VPS trojan template is missing in config_list.");
    }

    if (protocol === "trojan_obfuscated") {
      const templateByObfuscation = trojanTemplates.find((url) => isObfuscatedTrojanTemplate(url));

      if (templateByObfuscation !== undefined) {
        return templateByObfuscation;
      }

      const templateByPort = trojanTemplates.find(
        (url) => parsePortFromConfigUrl(url) === getTrojanObfsPort(),
      );

      if (templateByPort !== undefined) {
        return templateByPort;
      }

      return trojanTemplates[1] ?? trojanTemplates[0];
    }

    return (
      trojanTemplates.find((url) => !isObfuscatedTrojanTemplate(url)) ??
      trojanTemplates.find((url) => parsePortFromConfigUrl(url) === getTrojanDirectPort()) ??
      trojanTemplates[0]
    );
  }

  if (protocol === "vless_ws") {
    const vlessTemplates = configList.filter((url) => parseSchemeFromConfigUrl(url) === "vless");

    if (vlessTemplates.length === 0) {
      throw new Error("VPS vless template is missing in config_list.");
    }

    return (
      vlessTemplates.find((url) => parseLabelFromConfigUrl(url).includes("VLESS")) ??
      vlessTemplates[0]
    );
  }

  const shadowsocksTemplates = configList.filter((url) => parseSchemeFromConfigUrl(url) === "ss");

  if (shadowsocksTemplates.length === 0) {
    throw new Error("VPS shadowsocks template is missing in config_list.");
  }

  return (
    shadowsocksTemplates.find((url) => parseLabelFromConfigUrl(url).includes("SS")) ??
    shadowsocksTemplates.find((url) => parseLabelFromConfigUrl(url).includes("SHADOW")) ??
    shadowsocksTemplates[0]
  );
}

function appendConfigUrlIfMissing(currentConfigList: string[], url: string): string[] {
  if (currentConfigList.includes(url)) {
    return currentConfigList;
  }

  return [...currentConfigList, url];
}

function buildTrojanUrlFromTemplate(templateUrl: string, password: string, label: string): string {
  const parsedUrl = tryParseUrl(templateUrl);

  if (parsedUrl === null || parsedUrl.protocol !== "trojan:") {
    throw new Error("Invalid trojan template URL in VPS config_list.");
  }

  parsedUrl.username = password;
  parsedUrl.hash = label;
  return parsedUrl.toString();
}

function buildVlessUrlFromTemplate(templateUrl: string, clientId: string, label: string): string {
  const parsedUrl = tryParseUrl(templateUrl);

  if (parsedUrl === null || parsedUrl.protocol !== "vless:") {
    throw new Error("Invalid vless template URL in VPS config_list.");
  }

  parsedUrl.username = clientId;
  parsedUrl.hash = label;
  return parsedUrl.toString();
}

function buildShadowsocksUrlFromTemplate(
  templateUrl: string,
  password: string,
  label: string,
): string {
  const parsedUrl = tryParseUrl(templateUrl);

  if (parsedUrl === null || parsedUrl.protocol !== "ss:") {
    throw new Error("Invalid shadowsocks template URL in VPS config_list.");
  }

  if (parsedUrl.password.length > 0) {
    parsedUrl.password = password;
    parsedUrl.hash = label;
    return parsedUrl.toString();
  }

  const rawUsername = decodeURIComponent(parsedUrl.username);
  const decodedUsername = decodeBase64Flexible(rawUsername);
  const usernameCandidate = decodedUsername ?? rawUsername;
  const method = usernameCandidate.includes(":")
    ? usernameCandidate.split(":", 2)[0]
    : "aes-256-gcm";
  const encodedCredentials = Buffer.from(method + ":" + password, "utf8").toString("base64");

  parsedUrl.username = encodedCredentials;
  parsedUrl.password = "";
  parsedUrl.hash = label;
  return parsedUrl.toString();
}

function buildConfigUrlFromTemplate(
  protocol: VpsConfigProtocol,
  templateUrl: string,
  secret: string,
  label: string,
): string {
  if (protocol === "trojan" || protocol === "trojan_obfuscated") {
    return buildTrojanUrlFromTemplate(templateUrl, secret, label);
  }

  if (protocol === "vless_ws") {
    return buildVlessUrlFromTemplate(templateUrl, secret, label);
  }

  return buildShadowsocksUrlFromTemplate(templateUrl, secret, label);
}

function buildProtocolSuffix(protocol: VpsConfigProtocol): string {
  if (protocol === "trojan") {
    return "TROJAN";
  }

  if (protocol === "trojan_obfuscated") {
    return "TROJAN_OBFUSCATED";
  }

  if (protocol === "vless_ws") {
    return "VLESS";
  }

  return "SS";
}

function buildProtocolLabel(
  nickname: string,
  protocol: VpsConfigProtocol,
  isUnblock: boolean,
): string {
  if (isUnblock && protocol === "vless_ws") {
    return nickname;
  }

  return nickname + " " + buildProtocolSuffix(protocol);
}

export function getVpsProtocolDisplayName(protocol: VpsConfigProtocol): string {
  if (protocol === "trojan") {
    return "Trojan";
  }

  if (protocol === "trojan_obfuscated") {
    return "Trojan Obfuscated";
  }

  if (protocol === "vless_ws") {
    return "VLESS + WS";
  }

  return "Shadowsocks (WiFi & LAN)";
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

function buildVpsSshConfig(row: z.infer<typeof vpsIssueConfigRowSchema>): VpsSshConfig {
  if (row.isUnblock === true) {
    const sshConnectionKey = row.ssh_connection_key?.trim();

    if (sshConnectionKey === undefined || sshConnectionKey.length === 0) {
      throw new Error("VPS ssh_connection_key is empty for unblock server.");
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
    throw new Error("VPS ssh_key is empty for selected server.");
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
    throw new Error("VPS SSH password is empty for selected server.");
  }

  return {
    host: parsedSshKey.host ?? row.api_address,
    user: parsedSshKey.user,
    port: parsedSshKey.port ?? 22,
    password: sshPassword,
  };
}

export async function listUniqueVpsCountries(): Promise<VpsCountryOption[]> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("vps")
    .select("internal_uuid, country, country_emoji")
    .or("disabled.is.null,disabled.eq.false")
    .order("country", { ascending: true });

  if (error !== null) {
    throw new Error("Failed to fetch VPS countries: " + error.message);
  }

  const uniqueMap = new Map<string, VpsCountryOption>();

  for (const rawRow of data) {
    const row = parseVpsCountryRow(rawRow);
    const dedupeKey = row.country + "::" + row.country_emoji;

    if (!uniqueMap.has(dedupeKey)) {
      uniqueMap.set(dedupeKey, {
        internalUuid: row.internal_uuid,
        country: row.country,
        countryEmoji: row.country_emoji,
      });
    }
  }

  const countryOptions = Array.from(uniqueMap.values());

  countryOptions.sort((left, right) => {
    const leftIsUnblockLike = /unblock|whitelist|анблок|вайтлист/iu.test(left.country);
    const rightIsUnblockLike = /unblock|whitelist|анблок|вайтлист/iu.test(right.country);

    if (leftIsUnblockLike !== rightIsUnblockLike) {
      return leftIsUnblockLike ? -1 : 1;
    }

    return left.country.localeCompare(right.country, "ru");
  });

  return countryOptions;
}

export async function getVpsCountryByInternalUuid(internalUuid: string): Promise<string | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("vps")
    .select("country, disabled")
    .eq("internal_uuid", internalUuid)
    .maybeSingle();

  if (error !== null) {
    throw new Error("Failed to resolve VPS country: " + error.message);
  }

  if (data === null || data.disabled === true || typeof data.country !== "string") {
    return null;
  }

  return data.country;
}

export async function listVpsByCountry(country: string): Promise<VpsByCountryOption[]> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("vps")
    .select(
      'internal_uuid, nickname, country, country_emoji, "isUnblock", current_speed, number_of_connections',
    )
    .eq("country", country)
    .or("disabled.is.null,disabled.eq.false")
    .order("nickname", { ascending: true });

  if (error !== null) {
    throw new Error("Failed to fetch VPS by country: " + error.message);
  }

  const mapped = data.map((rawRow) => {
    const row = parseVpsByCountryRow(rawRow);
    return {
      internalUuid: row.internal_uuid,
      nickname: row.nickname,
      country: row.country,
      countryEmoji: row.country_emoji,
      isUnblock: row.isUnblock === true,
      currentSpeed: parseNonNegativeNumberOrZero(row.current_speed),
      numberOfConnections: parseNonNegativeNumberOrZero(row.number_of_connections),
    };
  });

  const hasUnblockLikeNickname = (nickname: string | null): boolean => {
    if (nickname === null) {
      return false;
    }

    const normalized = nickname.toLocaleLowerCase();
    return (
      normalized.includes("unblock") ||
      normalized.includes("whitelist") ||
      normalized.includes("анблок") ||
      normalized.includes("вайтлист")
    );
  };

  mapped.sort((left, right) => {
    const leftUnblockWeight = left.isUnblock || hasUnblockLikeNickname(left.nickname) ? 0 : 1;
    const rightUnblockWeight = right.isUnblock || hasUnblockLikeNickname(right.nickname) ? 0 : 1;

    if (leftUnblockWeight !== rightUnblockWeight) {
      return leftUnblockWeight - rightUnblockWeight;
    }

    const leftName = (left.nickname ?? "").toLocaleLowerCase();
    const rightName = (right.nickname ?? "").toLocaleLowerCase();

    if (leftName < rightName) {
      return -1;
    }

    if (leftName > rightName) {
      return 1;
    }

    return left.internalUuid.localeCompare(right.internalUuid);
  });

  return mapped;
}

export async function getVpsRouteInfoByInternalUuid(
  internalUuid: string,
): Promise<VpsRouteInfo | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("vps")
    .select('internal_uuid, nickname, country_emoji, disabled, "isUnblock"')
    .eq("internal_uuid", internalUuid)
    .maybeSingle();

  if (error !== null) {
    throw new Error("Failed to fetch VPS route info: " + error.message);
  }

  if (data === null) {
    return null;
  }

  const row = parseVpsRouteRow(data);

  if (row.disabled === true) {
    return null;
  }

  return {
    internalUuid: row.internal_uuid,
    nickname: row.nickname,
    countryEmoji: row.country_emoji,
    isUnblock: row.isUnblock === true,
  };
}

export async function getVpsConfigByInternalUuid(
  internalUuid: string,
): Promise<VpsConfigDetails | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("vps")
    .select("nickname, config_list, users_kv_map")
    .eq("internal_uuid", internalUuid)
    .or("disabled.is.null,disabled.eq.false")
    .maybeSingle();

  if (error !== null) {
    throw new Error("Failed to fetch VPS config list: " + error.message);
  }

  if (data === null) {
    return null;
  }

  const row = parseVpsConfigRow(data);
  return {
    nickname: row.nickname,
    configList: row.config_list,
  };
}

export async function issueOrGetUserVpsConfigUrl(
  internalUuid: string,
  userInternalUuid: string,
  protocol: VpsConfigProtocol,
): Promise<VpsUserConfigUrl | null> {
  const parsedProtocol = vpsConfigProtocolSchema.parse(protocol);
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("vps")
    .select(
      'nickname, config_list, users_kv_map, api_address, password, ssh_key, ssh_connection_key, "isUnblock", optional_passsword, disabled',
    )
    .eq("internal_uuid", internalUuid)
    .maybeSingle();

  if (error !== null) {
    throw new Error("Failed to fetch VPS config list: " + error.message);
  }

  if (data === null) {
    return null;
  }

  const row = parseVpsIssueConfigRow(data);

  if (row.disabled === true) {
    return null;
  }

  if (row.isUnblock === true && parsedProtocol !== "vless_ws") {
    throw new Error("Unblock server supports only VLESS + WS.");
  }

  const usersKvMap = parseUsersKvMap(row.users_kv_map);
  const existingEntry = usersKvMap[userInternalUuid];
  const existingProtocolEntry = existingEntry?.protocols[parsedProtocol];
  const nickname = row.nickname ?? "VPS";
  const sshConfig = buildVpsSshConfig(row);

  if (
    existingEntry !== undefined &&
    existingEntry.active !== false &&
    existingProtocolEntry !== undefined &&
    existingProtocolEntry.active !== false &&
    existingProtocolEntry.url.length > 0
  ) {
    await ensureVpsXrayClient({
      sshConfig,
      userInternalUuid,
      protocol: parsedProtocol,
      secret: decodeBase64Strict(existingProtocolEntry.secretBase64),
    });

    return {
      nickname,
      protocol: parsedProtocol,
      url: existingProtocolEntry.url,
      created: false,
    };
  }

  const template = pickTemplateForProtocol(row.config_list, parsedProtocol);
  const secretRaw = buildGeneratedSecret(parsedProtocol);
  const secretBase64 = Buffer.from(secretRaw, "utf8").toString("base64");
  const label = buildProtocolLabel(nickname, parsedProtocol, row.isUnblock === true);
  const generatedUrl = buildConfigUrlFromTemplate(parsedProtocol, template, secretRaw, label);

  await ensureVpsXrayClient({
    sshConfig,
    userInternalUuid,
    protocol: parsedProtocol,
    secret: secretRaw,
  });

  const currentEntry: VpsUserCredentialEntry = existingEntry ?? {
    createdAt: new Date().toISOString(),
    active: true,
    protocols: {},
  };
  const nextUsersKvMap: Partial<Record<string, VpsUserCredentialEntry>> = {
    ...usersKvMap,
    [userInternalUuid]: {
      ...currentEntry,
      active: true,
      protocols: {
        ...currentEntry.protocols,
        [parsedProtocol]: {
          secretBase64,
          url: generatedUrl,
          createdAt: new Date().toISOString(),
          active: true,
        },
      },
    },
  };
  const serializedUsersKvMap = serializeUsersKvMap(nextUsersKvMap);
  const nextConfigList = appendConfigUrlIfMissing(row.config_list, generatedUrl);

  const { error: updateError } = await supabase
    .from("vps")
    .update({
      users_kv_map: serializedUsersKvMap,
      config_list: nextConfigList,
    })
    .eq("internal_uuid", internalUuid);

  if (updateError !== null) {
    throw new Error("Failed to update users_kv_map for VPS: " + updateError.message);
  }

  return {
    nickname,
    protocol: parsedProtocol,
    url: generatedUrl,
    created: true,
  };
}

export async function issueOrGetUserVpsConfigUrls(
  internalUuid: string,
  userInternalUuid: string,
): Promise<VpsUserConfigUrls | null> {
  const directConfig = await issueOrGetUserVpsConfigUrl(internalUuid, userInternalUuid, "trojan");

  if (directConfig === null) {
    return null;
  }

  const obfsConfig = await issueOrGetUserVpsConfigUrl(
    internalUuid,
    userInternalUuid,
    "trojan_obfuscated",
  );

  if (obfsConfig === null) {
    return null;
  }

  return {
    nickname: directConfig.nickname,
    directUrl: directConfig.url,
    obfsUrl: obfsConfig.url,
    created: directConfig.created || obfsConfig.created,
  };
}
