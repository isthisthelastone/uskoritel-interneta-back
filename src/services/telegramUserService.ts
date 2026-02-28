import { z } from "zod";
import { getSupabaseAdminClient } from "../lib/supabaseAdmin";
import { addDays, addMonths, formatDateOnly, parseDateOnly } from "../shared";
import type { TelegramSubscriptionStatus } from "./telegramMenuService";

const telegramReferralEntrySchema = z.object({
  tgId: z.string().min(1),
  tgLogin: z.string().nullable(),
  tgNickname: z.string().nullable(),
  numberOfPurchase: z.number().int().nonnegative(),
});

const telegramReferredBySchema = z.object({
  tgId: z.string().min(1),
  tgNickname: z.string().nullable(),
  referDate: z.string().min(1),
});

const telegramGiftSchema = z.object({
  giftedByTgId: z.string().min(1),
  giftedByTgName: z.string().nullable(),
  timeAmountGifted: z.number().int().positive(),
  dateOfGift: z.string().min(1),
});

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
  number_of_referals: z.number().int().nonnegative(),
  earned_money: z.number().nonnegative(),
  refferals_data: z.array(telegramReferralEntrySchema),
  reffered_by: telegramReferredBySchema.nullable(),
  gifts: z.array(telegramGiftSchema),
});

export type TelegramUserRecord = z.infer<typeof telegramUserRowSchema>;
export type TelegramReferralEntry = z.infer<typeof telegramReferralEntrySchema>;
export type TelegramReferredBy = z.infer<typeof telegramReferredBySchema>;
export type TelegramGift = z.infer<typeof telegramGiftSchema>;

interface EnsureTelegramUserInput {
  tgId: string;
  tgNickname: string | null;
  referredBy?: TelegramReferredBy | null;
}

interface EnsureTelegramUserResult {
  user: TelegramUserRecord;
  created: boolean;
}

interface ActivateTelegramSubscriptionInput {
  tgId: string;
  tgNickname: string | null;
  months: number;
}

interface ActivateTelegramSubscriptionFromBalanceInput {
  tgId: string;
  tgNickname: string | null;
  months: number;
  amountUsd: number;
}

interface ApplyReferralRewardInput {
  payerTgId: string;
  payerTgNickname: string | null;
  purchaseAmountUsd: number;
}

interface ApplyReferralRewardResult {
  applied: boolean;
  referrerTgId: string | null;
  rewardAmountUsd: number;
  rewardPercent: number;
  referralPurchaseCount: number;
}

interface AddTelegramGiftInput {
  recipientTgId: string;
  recipientTgNickname: string | null;
  giftedByTgId: string;
  giftedByTgName: string | null;
  timeAmountGifted: number;
  setReferredByWhenUserCreated?: TelegramReferredBy | null;
}

interface ActivateTelegramGiftInput {
  tgId: string;
  tgNickname: string | null;
  giftIndex: number;
}

interface ActivateTelegramGiftResult {
  activatedGift: TelegramGift;
  user: TelegramUserRecord;
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
  "number_of_referals",
  "earned_money",
  "refferals_data",
  "reffered_by",
  "gifts",
].join(", ");

function parseTelegramUserRow(rawRow: unknown): TelegramUserRecord {
  return telegramUserRowSchema.parse(rawRow);
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
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

export async function findTelegramUserByNickname(
  tgNickname: string,
): Promise<TelegramUserRecord | null> {
  const normalizedNickname = tgNickname.trim().replace(/^@/u, "");

  if (normalizedNickname.length === 0) {
    return null;
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("users")
    .select(telegramUserSelectFields)
    .ilike("tg_nickname", normalizedNickname)
    .limit(1)
    .maybeSingle();

  if (error !== null) {
    throw new Error("Failed to fetch Telegram user by nickname: " + error.message);
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
      reffered_by: input.referredBy ?? null,
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
  if (!Number.isInteger(input.months) || input.months <= 0) {
    throw new Error("Invalid subscription months value.");
  }

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

export async function activateTelegramSubscriptionFromBalance(
  input: ActivateTelegramSubscriptionFromBalanceInput,
): Promise<TelegramUserRecord> {
  if (!Number.isInteger(input.months) || input.months <= 0) {
    throw new Error("Invalid subscription months value.");
  }

  if (!Number.isFinite(input.amountUsd) || input.amountUsd <= 0) {
    throw new Error("Invalid amountUsd value.");
  }

  const ensuredUser = await ensureTelegramUser({
    tgId: input.tgId,
    tgNickname: input.tgNickname,
  });
  const currentUser = ensuredUser.user;

  const nextEarnedMoney = roundUsd(currentUser.earned_money - input.amountUsd);

  if (nextEarnedMoney < 0) {
    throw new Error("INSUFFICIENT_REFERRAL_BALANCE");
  }

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
      earned_money: nextEarnedMoney,
    })
    .eq("tg_id", input.tgId)
    .gte("earned_money", input.amountUsd)
    .select(telegramUserSelectFields)
    .maybeSingle();

  if (error !== null) {
    throw new Error("Failed to activate Telegram subscription from balance: " + error.message);
  }

  if (data === null) {
    throw new Error("INSUFFICIENT_REFERRAL_BALANCE");
  }

  return parseTelegramUserRow(data);
}

export async function applyReferralRewardForPurchase(
  input: ApplyReferralRewardInput,
): Promise<ApplyReferralRewardResult> {
  if (!Number.isFinite(input.purchaseAmountUsd) || input.purchaseAmountUsd <= 0) {
    return {
      applied: false,
      referrerTgId: null,
      rewardAmountUsd: 0,
      rewardPercent: 0,
      referralPurchaseCount: 0,
    };
  }

  const payer = await getTelegramUserByTgId(input.payerTgId);

  if (payer === null || payer.reffered_by === null) {
    return {
      applied: false,
      referrerTgId: null,
      rewardAmountUsd: 0,
      rewardPercent: 0,
      referralPurchaseCount: 0,
    };
  }

  const referrerTgId = payer.reffered_by.tgId;

  if (referrerTgId === payer.tg_id) {
    return {
      applied: false,
      referrerTgId,
      rewardAmountUsd: 0,
      rewardPercent: 0,
      referralPurchaseCount: 0,
    };
  }

  const referrer = await getTelegramUserByTgId(referrerTgId);

  if (referrer === null) {
    return {
      applied: false,
      referrerTgId,
      rewardAmountUsd: 0,
      rewardPercent: 0,
      referralPurchaseCount: 0,
    };
  }

  const nextReferralsData = [...referrer.refferals_data];
  const existingEntryIndex = nextReferralsData.findIndex((entry) => entry.tgId === payer.tg_id);
  const currentPurchaseCount =
    existingEntryIndex >= 0 ? nextReferralsData[existingEntryIndex].numberOfPurchase : 0;
  const nextPurchaseCount = currentPurchaseCount + 1;
  const rewardPercent = currentPurchaseCount === 0 ? 0.2 : 0.1;
  const rewardAmountUsd = roundUsd(input.purchaseAmountUsd * rewardPercent);

  const nextEntry: TelegramReferralEntry = {
    tgId: payer.tg_id,
    tgLogin: payer.tg_nickname ?? input.payerTgNickname,
    tgNickname: input.payerTgNickname ?? payer.tg_nickname,
    numberOfPurchase: nextPurchaseCount,
  };

  if (existingEntryIndex >= 0) {
    nextReferralsData[existingEntryIndex] = nextEntry;
  } else {
    nextReferralsData.push(nextEntry);
  }

  const nextEarnedMoney = roundUsd(referrer.earned_money + rewardAmountUsd);
  const supabase = getSupabaseAdminClient();
  const { error } = await supabase
    .from("users")
    .update({
      earned_money: nextEarnedMoney,
      number_of_referals: nextReferralsData.length,
      refferals_data: nextReferralsData,
    })
    .eq("tg_id", referrer.tg_id);

  if (error !== null) {
    throw new Error("Failed to apply referral reward: " + error.message);
  }

  return {
    applied: true,
    referrerTgId: referrer.tg_id,
    rewardAmountUsd,
    rewardPercent,
    referralPurchaseCount: nextPurchaseCount,
  };
}

export async function addTelegramGift(input: AddTelegramGiftInput): Promise<TelegramUserRecord> {
  if (!Number.isInteger(input.timeAmountGifted) || input.timeAmountGifted <= 0) {
    throw new Error("Invalid timeAmountGifted value.");
  }

  const ensuredRecipient = await ensureTelegramUser({
    tgId: input.recipientTgId,
    tgNickname: input.recipientTgNickname,
    referredBy: input.setReferredByWhenUserCreated ?? null,
  });

  const nextGift: TelegramGift = {
    giftedByTgId: input.giftedByTgId,
    giftedByTgName: input.giftedByTgName,
    timeAmountGifted: input.timeAmountGifted,
    dateOfGift: new Date().toISOString().slice(0, 10),
  };
  const nextGifts = [...ensuredRecipient.user.gifts, nextGift];
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("users")
    .update({
      gifts: nextGifts,
    })
    .eq("tg_id", input.recipientTgId)
    .select(telegramUserSelectFields)
    .single();

  if (error !== null) {
    throw new Error("Failed to append gift to Telegram user: " + error.message);
  }

  return parseTelegramUserRow(data);
}

export async function activateTelegramGift(
  input: ActivateTelegramGiftInput,
): Promise<ActivateTelegramGiftResult> {
  if (!Number.isInteger(input.giftIndex) || input.giftIndex < 0) {
    throw new Error("Invalid gift index.");
  }

  const user = await getTelegramUserByTgId(input.tgId);

  if (user === null) {
    throw new Error("Telegram user not found for gift activation.");
  }

  if (input.giftIndex >= user.gifts.length) {
    throw new Error("GIFT_NOT_FOUND");
  }
  const gift = user.gifts[input.giftIndex];

  await activateTelegramSubscription({
    tgId: input.tgId,
    tgNickname: input.tgNickname,
    months: gift.timeAmountGifted,
  });

  const nextGifts = [...user.gifts];
  nextGifts.splice(input.giftIndex, 1);

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("users")
    .update({
      gifts: nextGifts,
    })
    .eq("tg_id", input.tgId)
    .select(telegramUserSelectFields)
    .single();

  if (error !== null) {
    throw new Error("Failed to update gift list after activation: " + error.message);
  }

  return {
    activatedGift: gift,
    user: parseTelegramUserRow(data),
  };
}
