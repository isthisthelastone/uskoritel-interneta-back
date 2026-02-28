import { z } from "zod";
import { getSupabaseAdminClient } from "../lib/supabaseAdmin";

const subscriptionPriceRowSchema = z.object({
  months: z.number().int().positive(),
  stars: z.number().int().positive(),
  usdt: z.union([z.number(), z.string()]),
  rubles: z.number().int().nonnegative(),
});

export interface SubscriptionPrice {
  months: number;
  stars: number;
  usdt: number;
  rubles: number;
}

function parseSubscriptionPriceRow(rawRow: unknown): SubscriptionPrice {
  const parsedRow = subscriptionPriceRowSchema.parse(rawRow);
  const parsedUsdt =
    typeof parsedRow.usdt === "number" ? parsedRow.usdt : Number.parseFloat(parsedRow.usdt);

  if (!Number.isFinite(parsedUsdt) || parsedUsdt < 0) {
    throw new Error("Invalid usdt value in subscription_prices row.");
  }

  return {
    months: parsedRow.months,
    stars: parsedRow.stars,
    usdt: parsedUsdt,
    rubles: parsedRow.rubles,
  };
}

export async function listSubscriptionPrices(): Promise<SubscriptionPrice[]> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("subscription_prices")
    .select("months, stars, usdt, rubles")
    .order("months", { ascending: true });

  if (error !== null) {
    throw new Error("Failed to fetch subscription prices: " + error.message);
  }

  return data.map((rawRow) => parseSubscriptionPriceRow(rawRow));
}

export async function getSubscriptionPriceByMonths(
  months: number,
): Promise<SubscriptionPrice | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("subscription_prices")
    .select("months, stars, usdt, rubles")
    .eq("months", months)
    .maybeSingle();

  if (error !== null) {
    throw new Error("Failed to fetch subscription price by months: " + error.message);
  }

  if (data === null) {
    return null;
  }

  return parseSubscriptionPriceRow(data);
}
