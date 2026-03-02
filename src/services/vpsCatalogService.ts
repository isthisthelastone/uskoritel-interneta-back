import { z } from "zod";
import { randomBytes } from "node:crypto";
import { getSupabaseAdminClient } from "../lib/supabaseAdmin";
import { ensureVpsTrojanClient } from "./vpsXrayService";
import type { VpsSshConfig } from "./vpsSshService";

const vpsCountryRowSchema = z.object({
  country: z.string().min(1),
  country_emoji: z.string().min(1),
});

const vpsByCountryRowSchema = z.object({
  internal_uuid: z.uuid(),
  nickname: z.string().nullable(),
  country: z.string().min(1),
  country_emoji: z.string().min(1),
});

const vpsConfigRowSchema = z.object({
  nickname: z.string().nullable(),
  config_list: z.array(z.string()),
  users_kv_map: z.unknown(),
});

const vpsIssueConfigRowSchema = vpsConfigRowSchema.extend({
  api_address: z.string().min(1),
  password: z.string().min(1),
  ssh_key: z.string().min(1),
  optional_passsword: z.string().nullable(),
});

const vpsUserCredentialEntrySchema = z.object({
  passwordBase64: z.string().min(1),
  directUrl: z.string().min(1),
  obfsUrl: z.string().min(1),
  createdAt: z.string().min(1),
  active: z.boolean().optional(),
});
type VpsUserCredentialEntry = z.infer<typeof vpsUserCredentialEntrySchema>;

export interface VpsCountryOption {
  country: string;
  countryEmoji: string;
}

export interface VpsByCountryOption {
  internalUuid: string;
  nickname: string | null;
  country: string;
  countryEmoji: string;
}

export interface VpsConfigDetails {
  nickname: string | null;
  configList: string[];
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

function parseVpsConfigRow(rawRow: unknown): z.infer<typeof vpsConfigRowSchema> {
  return vpsConfigRowSchema.parse(rawRow);
}

function parseVpsIssueConfigRow(rawRow: unknown): z.infer<typeof vpsIssueConfigRowSchema> {
  return vpsIssueConfigRowSchema.parse(rawRow);
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

    nextEntries[entryKey] = parsedEntry.data;
  }

  return nextEntries;
}

function buildGeneratedPassword(): string {
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
    throw new Error("Stored user passwordBase64 is invalid.");
  }

  return decoded;
}

function buildTrojanUrlFromTemplate(templateUrl: string, password: string, label: string): string {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(templateUrl);
  } catch {
    throw new Error("Invalid trojan template URL in VPS config_list.");
  }

  parsedUrl.username = password;
  parsedUrl.hash = label;
  return parsedUrl.toString();
}

function pickDirectAndObfsTemplates(configList: string[]): {
  directTemplate: string;
  obfsTemplate: string;
} {
  if (configList.length === 0) {
    throw new Error("VPS config_list is empty.");
  }

  const obfsTemplate =
    configList.find((url) => url.toLowerCase().includes("obfus")) ??
    configList.find((url) => url.includes(":8443")) ??
    configList[1];

  const directTemplate =
    configList.find((url) => url !== obfsTemplate) ??
    configList.find((url) => url.includes(":443")) ??
    configList[0];

  return {
    directTemplate,
    obfsTemplate,
  };
}

function appendUserUrlsToConfigList(
  currentConfigList: string[],
  directUrl: string,
  obfsUrl: string,
): string[] {
  const nextConfigList = [...currentConfigList];

  if (!nextConfigList.includes(directUrl)) {
    nextConfigList.push(directUrl);
  }

  if (!nextConfigList.includes(obfsUrl)) {
    nextConfigList.push(obfsUrl);
  }

  return nextConfigList;
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
  const parsedSshKey = parseSshKey(row.ssh_key);
  const decodedMainPassword = decodeBase64OrKeepRaw(row.password);
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
    .select("country, country_emoji")
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
        country: row.country,
        countryEmoji: row.country_emoji,
      });
    }
  }

  return Array.from(uniqueMap.values());
}

export async function listVpsByCountry(country: string): Promise<VpsByCountryOption[]> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("vps")
    .select("internal_uuid, nickname, country, country_emoji")
    .eq("country", country)
    .order("nickname", { ascending: true });

  if (error !== null) {
    throw new Error("Failed to fetch VPS by country: " + error.message);
  }

  return data.map((rawRow) => {
    const row = parseVpsByCountryRow(rawRow);
    return {
      internalUuid: row.internal_uuid,
      nickname: row.nickname,
      country: row.country,
      countryEmoji: row.country_emoji,
    };
  });
}

export async function getVpsConfigByInternalUuid(
  internalUuid: string,
): Promise<VpsConfigDetails | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("vps")
    .select("nickname, config_list, users_kv_map")
    .eq("internal_uuid", internalUuid)
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

export async function issueOrGetUserVpsConfigUrls(
  internalUuid: string,
  userInternalUuid: string,
): Promise<VpsUserConfigUrls | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("vps")
    .select(
      "nickname, config_list, users_kv_map, api_address, password, ssh_key, optional_passsword",
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
  const usersKvMap = parseUsersKvMap(row.users_kv_map);
  const existingEntry = usersKvMap[userInternalUuid];
  const nickname = row.nickname ?? "VPS";
  const sshConfig = buildVpsSshConfig(row);

  if (
    existingEntry !== undefined &&
    existingEntry.active !== false &&
    existingEntry.directUrl.length > 0 &&
    existingEntry.obfsUrl.length > 0
  ) {
    await ensureVpsTrojanClient({
      sshConfig,
      userInternalUuid,
      password: decodeBase64Strict(existingEntry.passwordBase64),
    });

    return {
      nickname,
      directUrl: existingEntry.directUrl,
      obfsUrl: existingEntry.obfsUrl,
      created: false,
    };
  }

  const templates = pickDirectAndObfsTemplates(row.config_list);
  const passwordRaw = buildGeneratedPassword();
  const passwordBase64 = Buffer.from(passwordRaw, "utf8").toString("base64");
  const directLabel = nickname;
  const obfsLabel = nickname + " OBFUSCATED";
  const directUrl = buildTrojanUrlFromTemplate(templates.directTemplate, passwordRaw, directLabel);
  const obfsUrl = buildTrojanUrlFromTemplate(templates.obfsTemplate, passwordRaw, obfsLabel);

  await ensureVpsTrojanClient({
    sshConfig,
    userInternalUuid,
    password: passwordRaw,
  });

  const nextUsersKvMap = {
    ...usersKvMap,
    [userInternalUuid]: {
      passwordBase64,
      directUrl,
      obfsUrl,
      createdAt: new Date().toISOString(),
      active: true,
    },
  };
  const nextConfigList = appendUserUrlsToConfigList(row.config_list, directUrl, obfsUrl);

  const { error: updateError } = await supabase
    .from("vps")
    .update({
      users_kv_map: nextUsersKvMap,
      config_list: nextConfigList,
    })
    .eq("internal_uuid", internalUuid);

  if (updateError !== null) {
    throw new Error("Failed to update users_kv_map for VPS: " + updateError.message);
  }

  return {
    nickname,
    directUrl,
    obfsUrl,
    created: true,
  };
}
