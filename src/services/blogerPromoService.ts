import { z } from "zod";
import { getSupabaseAdminClient } from "../lib/supabaseAdmin";

const blogerPromoStateSchema = z.object({
  tgId: z.string().min(1),
  tgNickname: z.string().nullable(),
});

const blogerPromoRowSchema = z.object({
  bloger_name: z.string().min(1),
  state_for_reffered_by: z.unknown().nullable(),
  promocode: z.string().min(1),
  amount_of_discount: z.number().int().nonnegative(),
});

export interface BlogerPromoStateForReferredBy {
  tgId: string;
  tgNickname: string | null;
}

export interface BlogerPromoRecord {
  blogerName: string;
  stateForReferredBy: BlogerPromoStateForReferredBy | null;
  promocode: string;
  amountOfDiscount: number;
}

function parseBlogerPromoState(rawValue: unknown): BlogerPromoStateForReferredBy | null {
  if (rawValue === null) {
    return null;
  }

  const parsedState = blogerPromoStateSchema.safeParse(rawValue);

  if (!parsedState.success) {
    return null;
  }

  return parsedState.data;
}

function parseBlogerPromoRow(rawRow: unknown): BlogerPromoRecord {
  const row = blogerPromoRowSchema.parse(rawRow);
  return {
    blogerName: row.bloger_name,
    stateForReferredBy: parseBlogerPromoState(row.state_for_reffered_by),
    promocode: row.promocode,
    amountOfDiscount: row.amount_of_discount,
  };
}

export async function getBlogerPromoByCode(promocode: string): Promise<BlogerPromoRecord | null> {
  const normalizedCode = promocode.trim();

  if (normalizedCode.length === 0) {
    return null;
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("blogers_promo")
    .select("bloger_name, state_for_reffered_by, promocode, amount_of_discount")
    .ilike("promocode", normalizedCode)
    .limit(1)
    .maybeSingle();

  if (error !== null) {
    throw new Error("Failed to fetch blogger promo: " + error.message);
  }

  if (data === null) {
    return null;
  }

  return parseBlogerPromoRow(data);
}
