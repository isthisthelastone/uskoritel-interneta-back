import { z } from "zod";
import type { TelegramMenuKey } from "../../../services/telegramMenuService";
import { decodeBase64Url, encodeBase64Url, parseJsonSafe } from "../../../shared";

const telegramMenuKeySchema = z.enum([
  "subscription_status",
  "how_to_use",
  "faq",
  "referals",
  "gifts",
  "settings",
  "countries",
]);

const purchaseMethodSchema = z.enum(["tg_stars", "tbd_1", "tbd_2"]);
const faqActionSchema = z.enum(["email", "rules"]);
export const howToPlatformSchema = z.enum(["ios", "android", "macos", "windows", "android_tv"]);
export const subscriptionPlanMonthsSchema = z.union([
  z.literal(1),
  z.literal(3),
  z.literal(6),
  z.literal(12),
]);
const invoicePayloadSchema = z.object({
  action: z.literal("subscription"),
  months: subscriptionPlanMonthsSchema,
  tgId: z.string(),
});

export type HowToPlatform = z.infer<typeof howToPlatformSchema>;
export type HowToAction = { platform: HowToPlatform };
export type FaqAction = { kind: z.infer<typeof faqActionSchema> };
export type CountriesAction =
  | { kind: "country"; country: string }
  | { kind: "vps"; internalUuid: string };
export type PurchaseAction =
  | { kind: "open" }
  | { kind: "method"; method: z.infer<typeof purchaseMethodSchema> }
  | { kind: "plan"; months: z.infer<typeof subscriptionPlanMonthsSchema> };
export type SubscriptionInvoicePayload = z.infer<typeof invoicePayloadSchema>;

export function getMenuKeyFromCallbackData(data: string | undefined): TelegramMenuKey | null {
  if (data === undefined || !data.startsWith("menu:")) {
    return null;
  }

  const rawMenuKey = data.slice("menu:".length);
  const parsedMenuKey = telegramMenuKeySchema.safeParse(rawMenuKey);

  if (!parsedMenuKey.success) {
    return null;
  }

  return parsedMenuKey.data;
}

export function getPurchaseActionFromCallbackData(data: string | undefined): PurchaseAction | null {
  if (data === undefined) {
    return null;
  }

  if (data === "buy:open") {
    return { kind: "open" };
  }

  if (data.startsWith("buy:method:")) {
    const methodRaw = data.slice("buy:method:".length);
    const parsedMethod = purchaseMethodSchema.safeParse(methodRaw);

    if (!parsedMethod.success) {
      return null;
    }

    return {
      kind: "method",
      method: parsedMethod.data,
    };
  }

  if (data.startsWith("buy:plan:")) {
    const monthsRaw = Number.parseInt(data.slice("buy:plan:".length), 10);
    const parsedMonths = subscriptionPlanMonthsSchema.safeParse(monthsRaw);

    if (!parsedMonths.success) {
      return null;
    }

    return {
      kind: "plan",
      months: parsedMonths.data,
    };
  }

  return null;
}

export function getFaqActionFromCallbackData(data: string | undefined): FaqAction | null {
  if (data === undefined || !data.startsWith("faq:")) {
    return null;
  }

  const rawAction = data.slice("faq:".length);
  const parsedAction = faqActionSchema.safeParse(rawAction);

  if (!parsedAction.success) {
    return null;
  }

  return {
    kind: parsedAction.data,
  };
}

export function getCountriesActionFromCallbackData(
  data: string | undefined,
): CountriesAction | null {
  if (data === undefined) {
    return null;
  }

  if (data.startsWith("countries:country:")) {
    const encodedCountry = data.slice("countries:country:".length);
    const decodedCountry = decodeBase64Url(encodedCountry)?.trim();

    if (decodedCountry === undefined || decodedCountry.length === 0 || decodedCountry.length > 64) {
      return null;
    }

    return {
      kind: "country",
      country: decodedCountry,
    };
  }

  if (data.startsWith("countries:vps:")) {
    const internalUuidRaw = data.slice("countries:vps:".length);
    const parsedUuid = z.uuid().safeParse(internalUuidRaw);

    if (!parsedUuid.success) {
      return null;
    }

    return {
      kind: "vps",
      internalUuid: parsedUuid.data,
    };
  }

  return null;
}

export function getHowToActionFromCallbackData(data: string | undefined): HowToAction | null {
  if (data === undefined || !data.startsWith("howto:")) {
    return null;
  }

  const rawPlatform = data.slice("howto:".length);
  const parsedPlatform = howToPlatformSchema.safeParse(rawPlatform);

  if (!parsedPlatform.success) {
    return null;
  }

  return {
    platform: parsedPlatform.data,
  };
}

export function buildSubscriptionInvoicePayload(
  tgId: number,
  months: z.infer<typeof subscriptionPlanMonthsSchema>,
): string {
  return JSON.stringify({
    action: "subscription",
    months,
    tgId: String(tgId),
  });
}

export function parseSubscriptionInvoicePayload(
  payload: string,
): SubscriptionInvoicePayload | null {
  const parsedJson = parseJsonSafe(payload);

  if (parsedJson === null) {
    return null;
  }

  const parsedPayload = invoicePayloadSchema.safeParse(parsedJson);

  if (!parsedPayload.success) {
    return null;
  }

  return parsedPayload.data;
}

export function encodeCountryCallbackValue(country: string): string {
  return encodeBase64Url(country);
}
