import { z } from "zod";
import { getSupabaseAdminClient } from "../lib/supabaseAdmin";
import { addDays, addMonths, formatDateOnly, parseDateOnly } from "../shared";
import type { TelegramSubscriptionStatus } from "./telegramMenuService";

const telegramUserRowSchema = z.object({
  internal_uuid: z.uuid(),
  tg_nickname: z.string().nullable(),
  tg_id: z.string(),
  subscription_active: z.boolean(),
  subscription_status: z.enum(["live", "ending"]).nullable(),
  subscription_untill: z.string().nullable(),
  traffic_consumed_mb: z.number(),
  number_of_connections: z.number().int(),
  number_of_connections_last_month: z.number().int(),
});

export type TelegramUserRecord = z.infer<typeof telegramUserRowSchema>;

interface EnsureTelegramUserInput {
  tgId: string;
  tgNickname: string | null;
}

interface EnsureTelegramUserResult {
  user: TelegramUserRecord;
  created: boolean;
}

interface ActivateTelegramSubscriptionInput {
  tgId: string;
  tgNickname: string | null;
  months: 1 | 3 | 6 | 12;
}

const telegramUserSelectFields = [
  "internal_uuid",
  "tg_nickname",
  "tg_id",
  "subscription_active",
  "subscription_status",
  "subscription_untill",
  "traffic_consumed_mb",
  "number_of_connections",
  "number_of_connections_last_month",
].join(", ");

function parseTelegramUserRow(rawRow: unknown): TelegramUserRecord {
  return telegramUserRowSchema.parse(rawRow);
}

export async function getTelegramUserByTgId(tgId: string): Promise<TelegramUserRecord | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("users")
    .select(telegramUserSelectFields)
    .eq("tg_id", tgId)
    .maybeSingle();

  if (error !== null) {
    throw new Error("Failed to fetch Telegram user: " + error.message);
  }

  if (data === null) {
    return null;
  }

  return parseTelegramUserRow(data);
}

async function updateTelegramNicknameIfChanged(
  tgId: string,
  currentNickname: string | null,
  incomingNickname: string | null,
): Promise<void> {
  if (incomingNickname === null || incomingNickname === currentNickname) {
    return;
  }

  const supabase = getSupabaseAdminClient();
  const { error } = await supabase
    .from("users")
    .update({ tg_nickname: incomingNickname })
    .eq("tg_id", tgId);

  if (error !== null) {
    throw new Error("Failed to update Telegram nickname: " + error.message);
  }
}

export async function ensureTelegramUser(
  input: EnsureTelegramUserInput,
): Promise<EnsureTelegramUserResult> {
  const existingUser = await getTelegramUserByTgId(input.tgId);

  if (existingUser !== null) {
    await updateTelegramNicknameIfChanged(input.tgId, existingUser.tg_nickname, input.tgNickname);
    const refreshedUser = await getTelegramUserByTgId(input.tgId);

    if (refreshedUser === null) {
      throw new Error("Telegram user disappeared after update.");
    }

    return {
      user: refreshedUser,
      created: false,
    };
  }

  const supabase = getSupabaseAdminClient();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const trialUntillDate = addDays(today, 3);
  const trialUntill = formatDateOnly(trialUntillDate);
  const { data, error } = await supabase
    .from("users")
    .insert({
      tg_id: input.tgId,
      tg_nickname: input.tgNickname,
      subscription_active: true,
      subscription_status: "ending",
      subscription_untill: trialUntill,
    })
    .select(telegramUserSelectFields)
    .single();

  if (error !== null) {
    if (error.code === "23505") {
      const concurrentUser = await getTelegramUserByTgId(input.tgId);

      if (concurrentUser !== null) {
        return {
          user: concurrentUser,
          created: false,
        };
      }
    }

    throw new Error("Failed to create Telegram user: " + error.message);
  }

  return {
    user: parseTelegramUserRow(data),
    created: true,
  };
}

export function mapTelegramUserToMenuSubscriptionStatus(
  user: TelegramUserRecord,
): TelegramSubscriptionStatus {
  if (user.subscription_status === "live") {
    return "active";
  }

  if (user.subscription_status === "ending") {
    return "trial";
  }

  if (user.subscription_active) {
    return "active";
  }

  return "expired";
}

export async function activateTelegramSubscription(
  input: ActivateTelegramSubscriptionInput,
): Promise<TelegramUserRecord> {
  const ensuredUser = await ensureTelegramUser({
    tgId: input.tgId,
    tgNickname: input.tgNickname,
  });
  const currentUser = ensuredUser.user;

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const currentUntil = currentUser.subscription_untill
    ? parseDateOnly(currentUser.subscription_untill)
    : null;

  const baseDate =
    currentUntil !== null && currentUntil.getTime() > today.getTime() ? currentUntil : today;
  const newUntilDate = addMonths(baseDate, input.months);
  const newUntil = formatDateOnly(newUntilDate);

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("users")
    .update({
      subscription_active: true,
      subscription_status: "live",
      subscription_untill: newUntil,
    })
    .eq("tg_id", input.tgId)
    .select(telegramUserSelectFields)
    .single();

  if (error !== null) {
    throw new Error("Failed to activate Telegram subscription: " + error.message);
  }

  return parseTelegramUserRow(data);
}
