import { z } from "zod";
import { randomBytes } from "node:crypto";
import { getSupabaseAdminClient } from "../lib/supabaseAdmin";

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
  const usersKvMap = parseUsersKvMap(row.users_kv_map);
  const existingEntry = usersKvMap[userInternalUuid];
  const nickname = row.nickname ?? "VPS";

  if (
    existingEntry !== undefined &&
    existingEntry.active !== false &&
    existingEntry.directUrl.length > 0 &&
    existingEntry.obfsUrl.length > 0
  ) {
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

  const { error: updateError } = await supabase
    .from("vps")
    .update({
      users_kv_map: nextUsersKvMap,
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
