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
  "admin_panel",
]);

const purchaseMethodSchema = z.enum(["tg_stars", "crypto_bot", "tbd_1", "tbd_2"]);
const faqActionSchema = z.enum(["email", "rules"]);
const referalsActionSchema = z.enum(["prolong"]);
const settingsActionSchema = z.enum([
  "whitelist_unblock",
  "vless_websocket",
  "trojan",
  "trojan_obfuscated",
  "shadowsocks_wifi",
]);
const adminUsersActionSchema = z.enum(["ban", "unban", "disconnect_all"]);
const adminServersActionSchema = z.enum(["enable", "reload", "disable"]);
export const howToPlatformSchema = z.enum(["ios", "android", "macos", "windows", "android_tv"]);
export const subscriptionPlanMonthsSchema = z.number().int().positive();
const giftIndexSchema = z.number().int().nonnegative();
const cryptoBotInvoiceIdSchema = z.number().int().positive();
const adminUsersPageSchema = z.number().int().positive();
const tgIdSchema = z.string().regex(/^[1-9]\d{0,19}$/u);
const invoicePayloadSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("subscription"),
    months: subscriptionPlanMonthsSchema,
    tgId: tgIdSchema,
  }),
  z.object({
    action: z.literal("gift"),
    months: subscriptionPlanMonthsSchema,
    tgId: tgIdSchema,
    recipientTgId: tgIdSchema,
  }),
]);

export type HowToPlatform = z.infer<typeof howToPlatformSchema>;
export type HowToAction = { platform: HowToPlatform };
export type FaqAction = { kind: z.infer<typeof faqActionSchema> };
export type SettingsAction = { kind: z.infer<typeof settingsActionSchema> };
export type AdminAction =
  | { kind: "root" }
  | { kind: "users" }
  | { kind: "users_list"; page: number }
  | { kind: "users_detail"; tgId: string }
  | { kind: "users_prompt"; action: z.infer<typeof adminUsersActionSchema> }
  | { kind: "servers" }
  | { kind: "servers_detail"; internalUuid: string }
  | {
      kind: "servers_action";
      action: z.infer<typeof adminServersActionSchema>;
      internalUuid: string;
    };
export type ReferalsAction =
  | { kind: z.infer<typeof referalsActionSchema> }
  | { kind: "balance_plan"; months: number };
export type GiftsAction =
  | { kind: "my" }
  | { kind: "give" }
  | { kind: "promo" }
  | { kind: "view"; giftIndex: number }
  | { kind: "activate"; giftIndex: number }
  | { kind: "method"; method: z.infer<typeof purchaseMethodSchema>; recipientTgId: string }
  | { kind: "plan"; months: number; recipientTgId: string };
export type CountriesAction =
  | { kind: "country"; country: string }
  | { kind: "vps"; internalUuid: string };
export type PurchaseAction =
  | { kind: "open" }
  | { kind: "method"; method: z.infer<typeof purchaseMethodSchema> }
  | {
      kind: "plan";
      method: z.infer<typeof purchaseMethodSchema>;
      months: z.infer<typeof subscriptionPlanMonthsSchema>;
    }
  | { kind: "crypto_check"; invoiceId: z.infer<typeof cryptoBotInvoiceIdSchema> }
  | { kind: "crypto_cancel"; invoiceId: z.infer<typeof cryptoBotInvoiceIdSchema> }
  | { kind: "crypto_cancel_confirm"; invoiceId: z.infer<typeof cryptoBotInvoiceIdSchema> }
  | { kind: "crypto_cancel_abort"; invoiceId: z.infer<typeof cryptoBotInvoiceIdSchema> };
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

  if (data.startsWith("buy:crypto_check:")) {
    const invoiceIdRaw = Number.parseInt(data.slice("buy:crypto_check:".length), 10);
    const parsedInvoiceId = cryptoBotInvoiceIdSchema.safeParse(invoiceIdRaw);

    if (!parsedInvoiceId.success) {
      return null;
    }

    return {
      kind: "crypto_check",
      invoiceId: parsedInvoiceId.data,
    };
  }

  if (data.startsWith("buy:crypto_cancel_confirm:")) {
    const invoiceIdRaw = Number.parseInt(data.slice("buy:crypto_cancel_confirm:".length), 10);
    const parsedInvoiceId = cryptoBotInvoiceIdSchema.safeParse(invoiceIdRaw);

    if (!parsedInvoiceId.success) {
      return null;
    }

    return {
      kind: "crypto_cancel_confirm",
      invoiceId: parsedInvoiceId.data,
    };
  }

  if (data.startsWith("buy:crypto_cancel_abort:")) {
    const invoiceIdRaw = Number.parseInt(data.slice("buy:crypto_cancel_abort:".length), 10);
    const parsedInvoiceId = cryptoBotInvoiceIdSchema.safeParse(invoiceIdRaw);

    if (!parsedInvoiceId.success) {
      return null;
    }

    return {
      kind: "crypto_cancel_abort",
      invoiceId: parsedInvoiceId.data,
    };
  }

  if (data.startsWith("buy:crypto_cancel:")) {
    const invoiceIdRaw = Number.parseInt(data.slice("buy:crypto_cancel:".length), 10);
    const parsedInvoiceId = cryptoBotInvoiceIdSchema.safeParse(invoiceIdRaw);

    if (!parsedInvoiceId.success) {
      return null;
    }

    return {
      kind: "crypto_cancel",
      invoiceId: parsedInvoiceId.data,
    };
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
    const planRaw = data.slice("buy:plan:".length);
    const planParts = planRaw.split(":");
    let methodRaw = "";
    let monthsRaw = NaN;

    if (planParts.length === 1) {
      methodRaw = "tg_stars";
      monthsRaw = Number.parseInt(planParts[0], 10);
    } else if (planParts.length === 2) {
      methodRaw = planParts[0];
      monthsRaw = Number.parseInt(planParts[1], 10);
    } else {
      return null;
    }

    const parsedMethod = purchaseMethodSchema.safeParse(methodRaw);
    const parsedMonths = subscriptionPlanMonthsSchema.safeParse(monthsRaw);

    if (!parsedMethod.success || !parsedMonths.success) {
      return null;
    }

    return {
      kind: "plan",
      method: parsedMethod.data,
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

export function getReferalsActionFromCallbackData(data: string | undefined): ReferalsAction | null {
  if (data === undefined) {
    return null;
  }

  if (data.startsWith("referals:")) {
    const rawAction = data.slice("referals:".length);
    const parsedAction = referalsActionSchema.safeParse(rawAction);

    if (parsedAction.success) {
      return {
        kind: parsedAction.data,
      };
    }
  }

  if (data.startsWith("referals:balance_plan:")) {
    const monthsRaw = Number.parseInt(data.slice("referals:balance_plan:".length), 10);
    const parsedMonths = subscriptionPlanMonthsSchema.safeParse(monthsRaw);

    if (!parsedMonths.success) {
      return null;
    }

    return {
      kind: "balance_plan",
      months: parsedMonths.data,
    };
  }

  return null;
}

export function getSettingsActionFromCallbackData(data: string | undefined): SettingsAction | null {
  if (data === undefined || !data.startsWith("settings:")) {
    return null;
  }

  const rawAction = data.slice("settings:".length);
  const parsedAction = settingsActionSchema.safeParse(rawAction);

  if (!parsedAction.success) {
    return null;
  }

  return {
    kind: parsedAction.data,
  };
}

export function getAdminActionFromCallbackData(data: string | undefined): AdminAction | null {
  if (data === undefined || !data.startsWith("admin:")) {
    return null;
  }

  if (data === "admin:root") {
    return { kind: "root" };
  }

  if (data === "admin:users") {
    return { kind: "users" };
  }

  if (data.startsWith("admin:users:list:")) {
    const pageRaw = Number.parseInt(data.slice("admin:users:list:".length), 10);
    const parsedPage = adminUsersPageSchema.safeParse(pageRaw);

    if (!parsedPage.success) {
      return null;
    }

    return {
      kind: "users_list",
      page: parsedPage.data,
    };
  }

  if (data.startsWith("admin:users:detail:")) {
    const tgIdRaw = data.slice("admin:users:detail:".length);
    const parsedTgId = tgIdSchema.safeParse(tgIdRaw);

    if (!parsedTgId.success) {
      return null;
    }

    return {
      kind: "users_detail",
      tgId: parsedTgId.data,
    };
  }

  if (data.startsWith("admin:users:prompt:")) {
    const actionRaw = data.slice("admin:users:prompt:".length);
    const parsedAction = adminUsersActionSchema.safeParse(actionRaw);

    if (!parsedAction.success) {
      return null;
    }

    return {
      kind: "users_prompt",
      action: parsedAction.data,
    };
  }

  if (data === "admin:servers") {
    return { kind: "servers" };
  }

  if (data.startsWith("admin:servers:detail:")) {
    const internalUuidRaw = data.slice("admin:servers:detail:".length);
    const parsedUuid = z.uuid().safeParse(internalUuidRaw);

    if (!parsedUuid.success) {
      return null;
    }

    return {
      kind: "servers_detail",
      internalUuid: parsedUuid.data,
    };
  }

  if (data.startsWith("admin:servers:action:")) {
    const parts = data.split(":");

    if (parts.length !== 5) {
      return null;
    }

    const parsedAction = adminServersActionSchema.safeParse(parts[3]);
    const parsedUuid = z.uuid().safeParse(parts[4]);

    if (!parsedAction.success || !parsedUuid.success) {
      return null;
    }

    return {
      kind: "servers_action",
      action: parsedAction.data,
      internalUuid: parsedUuid.data,
    };
  }

  return null;
}

export function getGiftsActionFromCallbackData(data: string | undefined): GiftsAction | null {
  if (data === undefined) {
    return null;
  }

  if (data === "gift:my") {
    return { kind: "my" };
  }

  if (data === "gift:give") {
    return { kind: "give" };
  }

  if (data === "gift:promo") {
    return { kind: "promo" };
  }

  if (data.startsWith("gift:view:")) {
    const rawGiftIndex = Number.parseInt(data.slice("gift:view:".length), 10);
    const parsedGiftIndex = giftIndexSchema.safeParse(rawGiftIndex);

    if (!parsedGiftIndex.success) {
      return null;
    }

    return {
      kind: "view",
      giftIndex: parsedGiftIndex.data,
    };
  }

  if (data.startsWith("gift:activate:")) {
    const rawGiftIndex = Number.parseInt(data.slice("gift:activate:".length), 10);
    const parsedGiftIndex = giftIndexSchema.safeParse(rawGiftIndex);

    if (!parsedGiftIndex.success) {
      return null;
    }

    return {
      kind: "activate",
      giftIndex: parsedGiftIndex.data,
    };
  }

  if (data.startsWith("gift:method:")) {
    const parts = data.split(":");

    if (parts.length !== 4) {
      return null;
    }

    const parsedMethod = purchaseMethodSchema.safeParse(parts[2]);
    const parsedRecipientTgId = tgIdSchema.safeParse(parts[3]);

    if (!parsedMethod.success || !parsedRecipientTgId.success) {
      return null;
    }

    return {
      kind: "method",
      method: parsedMethod.data,
      recipientTgId: parsedRecipientTgId.data,
    };
  }

  if (data.startsWith("gift:plan:")) {
    const parts = data.split(":");

    if (parts.length !== 4) {
      return null;
    }

    const rawMonths = Number.parseInt(parts[2], 10);
    const parsedMonths = subscriptionPlanMonthsSchema.safeParse(rawMonths);
    const parsedRecipientTgId = tgIdSchema.safeParse(parts[3]);

    if (!parsedMonths.success || !parsedRecipientTgId.success) {
      return null;
    }

    return {
      kind: "plan",
      months: parsedMonths.data,
      recipientTgId: parsedRecipientTgId.data,
    };
  }

  return null;
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

export function buildGiftInvoicePayload(
  tgId: number,
  recipientTgId: string,
  months: z.infer<typeof subscriptionPlanMonthsSchema>,
): string {
  return JSON.stringify({
    action: "gift",
    months,
    tgId: String(tgId),
    recipientTgId,
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
