import { z } from "zod";
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
});

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

function parseVpsCountryRow(rawRow: unknown): z.infer<typeof vpsCountryRowSchema> {
  return vpsCountryRowSchema.parse(rawRow);
}

function parseVpsByCountryRow(rawRow: unknown): z.infer<typeof vpsByCountryRowSchema> {
  return vpsByCountryRowSchema.parse(rawRow);
}

function parseVpsConfigRow(rawRow: unknown): z.infer<typeof vpsConfigRowSchema> {
  return vpsConfigRowSchema.parse(rawRow);
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
    .select("nickname, config_list")
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
