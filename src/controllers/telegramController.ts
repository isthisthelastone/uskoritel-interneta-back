import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import {
  answerTelegramCallbackQuery,
  answerTelegramPreCheckoutQuery,
  editTelegramInlineMenuMessage,
  sendTelegramInlineMenuMessage,
  sendTelegramPhotoMessage,
  sendTelegramStarsInvoice,
  sendTelegramTextMessage,
} from "../services/telegramBotService";
import { buildTelegramMenu, type TelegramMenuKey } from "../services/telegramMenuService";
import {
  activateTelegramSubscription,
  ensureTelegramUser,
  getTelegramUserByTgId,
  mapTelegramUserToMenuSubscriptionStatus,
} from "../services/telegramUserService";
import {
  getVpsConfigByInternalUuid,
  listUniqueVpsCountries,
  listVpsByCountry,
} from "../services/vpsCatalogService";

const telegramMenuQuerySchema = z.object({
  status: z.enum(["active", "trial", "expired", "unknown"]).optional(),
});

const telegramMessageSchema = z.object({
  message_id: z.number().optional(),
  chat: z.object({
    id: z.number(),
    type: z.enum(["private", "group", "supergroup", "channel"]).optional(),
  }),
  from: z
    .object({
      id: z.number(),
      username: z.string().optional(),
    })
    .optional(),
  text: z.string().optional(),
  successful_payment: z
    .object({
      currency: z.string(),
      total_amount: z.number(),
      invoice_payload: z.string(),
    })
    .optional(),
});

const telegramCallbackQuerySchema = z.object({
  id: z.string(),
  data: z.string().optional(),
  from: z.object({
    id: z.number(),
  }),
  message: telegramMessageSchema.optional(),
});

const telegramPreCheckoutQuerySchema = z.object({
  id: z.string(),
  from: z.object({
    id: z.number(),
  }),
  currency: z.string(),
  total_amount: z.number(),
  invoice_payload: z.string(),
});

const telegramUpdateSchema = z.object({
  update_id: z.number().optional(),
  message: telegramMessageSchema.optional(),
  edited_message: telegramMessageSchema.optional(),
  callback_query: telegramCallbackQuerySchema.optional(),
  pre_checkout_query: telegramPreCheckoutQuerySchema.optional(),
});

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
const subscriptionPlanMonthsSchema = z.union([
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

const suspiciousCommandPattern =
  /\b(?:id|user_id|chat_id|admin_id|target_id|uid)\s*[:=]\s*\d+\b|tg:\/\/user\?id=|\b\d{8,}\b/iu;

interface ParsedTelegramCommand {
  command: string | null;
  isSuspicious: boolean;
  reason?: string;
}

type PurchaseAction =
  | { kind: "open" }
  | { kind: "method"; method: z.infer<typeof purchaseMethodSchema> }
  | { kind: "plan"; months: z.infer<typeof subscriptionPlanMonthsSchema> };

type CountriesAction = { kind: "country"; country: string } | { kind: "vps"; internalUuid: string };
const howToPlatformSchema = z.enum(["ios", "android", "macos", "windows", "android_tv"]);
type HowToAction = { platform: z.infer<typeof howToPlatformSchema> };

function encodeCallbackValue(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeCallbackValue(value: string): string | null {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function getTelegramCommand(text: string | undefined): ParsedTelegramCommand {
  if (text === undefined) {
    return {
      command: null,
      isSuspicious: false,
    };
  }

  const normalizedText = text.trim();

  if (!normalizedText.startsWith("/")) {
    return {
      command: null,
      isSuspicious: false,
    };
  }

  if (normalizedText.length > 64 || suspiciousCommandPattern.test(normalizedText)) {
    return {
      command: null,
      isSuspicious: true,
      reason: "Potential ID injection payload detected.",
    };
  }

  const tokens = normalizedText.split(/\s+/u).filter((token) => token.length > 0);
  const firstToken = tokens[0] ?? "";
  const commandMatch = /^\/([a-z_]+)(?:@([a-z0-9_]{3,}))?$/iu.exec(firstToken);

  if (commandMatch === null) {
    return {
      command: null,
      isSuspicious: true,
      reason: "Malformed Telegram command.",
    };
  }

  if (tokens.length > 1) {
    return {
      command: null,
      isSuspicious: true,
      reason: "Command arguments are blocked for security.",
    };
  }

  const botMention = commandMatch.at(2)?.toLowerCase() ?? "";
  const expectedBotUsername = (process.env.BOT_USERNAME ?? "").replace(/^@/u, "").toLowerCase();

  if (
    botMention.length > 0 &&
    expectedBotUsername.length > 0 &&
    botMention !== expectedBotUsername
  ) {
    return {
      command: null,
      isSuspicious: false,
      reason: "Command is addressed to a different bot.",
    };
  }

  return {
    command: "/" + commandMatch[1].toLowerCase(),
    isSuspicious: false,
  };
}

function getMenuKeyFromCallbackData(data: string | undefined): TelegramMenuKey | null {
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

function getPurchaseActionFromCallbackData(data: string | undefined): PurchaseAction | null {
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

function getCountriesActionFromCallbackData(data: string | undefined): CountriesAction | null {
  if (data === undefined) {
    return null;
  }

  if (data.startsWith("countries:country:")) {
    const encodedCountry = data.slice("countries:country:".length);
    const decodedCountry = decodeCallbackValue(encodedCountry)?.trim();

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

function getHowToActionFromCallbackData(data: string | undefined): HowToAction | null {
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

function buildSubscriptionInvoicePayload(
  tgId: number,
  months: z.infer<typeof subscriptionPlanMonthsSchema>,
): string {
  return JSON.stringify({
    action: "subscription",
    months,
    tgId: String(tgId),
  });
}

function parseSubscriptionInvoicePayload(
  payload: string,
): z.infer<typeof invoicePayloadSchema> | null {
  try {
    const parsedJson: unknown = JSON.parse(payload);
    const parsedPayload = invoicePayloadSchema.safeParse(parsedJson);

    if (!parsedPayload.success) {
      return null;
    }

    return parsedPayload.data;
  } catch {
    return null;
  }
}

function getMenuSectionText(menuKey: TelegramMenuKey): string {
  const menuSectionTextMap: Record<TelegramMenuKey, string> = {
    subscription_status: "Subscription status: ⚪ Unknown. We will sync your real status soon.",
    how_to_use: "How to use: choose a VPN location, connect, and keep this bot for quick controls.",
    faq: "FAQ: we will add common VPN setup and troubleshooting answers here.",
    referals: "Referals: invite friends and receive bonus days after successful activation.",
    gifts: "Gifts: seasonal promo codes and gift subscriptions will appear here.",
    settings: "Settings: language, notifications, and account preferences.",
    countries: "Список стран",
  };

  return menuSectionTextMap[menuKey];
}

function buildSubscriptionStatusTextFromDb(
  subscriptionStatus: "live" | "ending" | null,
  subscriptionUntill: string | null,
): string {
  if (subscriptionStatus === "live") {
    return [
      "🟢 SUBSCRIPTION STATUS: LIVE",
      subscriptionUntill !== null ? "Valid until: " + subscriptionUntill : null,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }

  if (subscriptionStatus === "ending") {
    return [
      "🟠 SUBSCRIPTION STATUS: ENDING",
      subscriptionUntill !== null ? "Valid until: " + subscriptionUntill : null,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }

  return "🔴 SUBSCRIPTION STATUS: NOT FOUND";
}

function hasAccessToServers(
  subscriptionStatus: "live" | "ending" | null,
  subscriptionActive: boolean,
): boolean {
  return subscriptionActive || subscriptionStatus === "live" || subscriptionStatus === "ending";
}

async function sendSubscriptionRequiredForServersMessage(chatId: number) {
  return sendTelegramInlineMenuMessage({
    chatId,
    text: "ЧТОБЫ ПОСМОТРЕТЬ СЕРВЕРА НУЖНО КУПИТЬ ПОДПИСКУ, ВОТ КАК ЭТО МОЖНО СДЕЛАТЬ:",
    inlineKeyboardRows: [
      [{ text: "⭐ Telegram Stars", callbackData: "buy:method:tg_stars" }],
      [{ text: "TBD", callbackData: "buy:method:tbd_1" }],
      [{ text: "TBD", callbackData: "buy:method:tbd_2" }],
    ],
  });
}

function getHowToPlatformLabel(platform: z.infer<typeof howToPlatformSchema>): string {
  const labels: Record<z.infer<typeof howToPlatformSchema>, string> = {
    ios: "🍎 iOS",
    android: "🤖 Android",
    macos: "💻 macOS",
    windows: "🪟 Windows",
    android_tv: "📺 Android TV",
  };

  return labels[platform];
}

export function requireTelegramSecret(req: Request, res: Response, next: NextFunction): void {
  const expectedSecret = process.env.TG_SECRET;

  if (expectedSecret === undefined || expectedSecret.length === 0) {
    res.status(500).json({
      ok: false,
      message: "TG_SECRET is not configured.",
    });
    return;
  }

  const providedSecret =
    req.header("x-telegram-secret") ?? req.header("x-telegram-bot-api-secret-token");

  if (providedSecret !== expectedSecret) {
    res.status(401).json({
      ok: false,
      message: "Unauthorized: invalid Telegram secret.",
    });
    return;
  }

  next();
}

export function getTelegramMenu(req: Request, res: Response): void {
  const parsedQuery = telegramMenuQuerySchema.safeParse(req.query);

  if (!parsedQuery.success) {
    res.status(400).json({
      ok: false,
      message: "Invalid query parameters.",
      errors: z.treeifyError(parsedQuery.error),
    });
    return;
  }

  const subscriptionStatus = parsedQuery.data.status ?? "unknown";
  const payload = buildTelegramMenu(subscriptionStatus);

  res.status(200).json({
    ok: true,
    data: payload,
  });
}

export async function handleTelegramMenuWebhook(req: Request, res: Response): Promise<void> {
  const parsedUpdate = telegramUpdateSchema.safeParse(req.body);

  if (!parsedUpdate.success) {
    res.status(200).json({
      ok: true,
      processed: false,
      reason: "Invalid Telegram update payload.",
    });
    return;
  }

  const preCheckoutQuery = parsedUpdate.data.pre_checkout_query;

  if (preCheckoutQuery !== undefined) {
    const invoicePayload = parseSubscriptionInvoicePayload(preCheckoutQuery.invoice_payload);
    const isValidPayload =
      invoicePayload !== null &&
      preCheckoutQuery.currency === "XTR" &&
      preCheckoutQuery.total_amount === invoicePayload.months &&
      invoicePayload.tgId === String(preCheckoutQuery.from.id);

    const preCheckoutAnswerResult = await answerTelegramPreCheckoutQuery({
      preCheckoutQueryId: preCheckoutQuery.id,
      ok: isValidPayload,
      errorMessage: "Payment validation failed. Please retry from bot menu.",
    });

    if (!preCheckoutAnswerResult.ok) {
      console.error(
        "Failed to answer pre-checkout query:",
        preCheckoutAnswerResult.statusCode,
        preCheckoutAnswerResult.error,
      );
    }

    res.status(200).json({
      ok: true,
      processed: true,
      preCheckoutValidated: isValidPayload,
    });
    return;
  }

  const callbackQuery = parsedUpdate.data.callback_query;

  if (callbackQuery !== undefined) {
    const menuKey = getMenuKeyFromCallbackData(callbackQuery.data);
    const purchaseAction = getPurchaseActionFromCallbackData(callbackQuery.data);
    const countriesAction = getCountriesActionFromCallbackData(callbackQuery.data);
    const howToAction = getHowToActionFromCallbackData(callbackQuery.data);
    const callbackChatId = callbackQuery.message?.chat.id;
    const callbackMessageId = callbackQuery.message?.message_id;
    const callbackChatType = callbackQuery.message?.chat.type;

    if (
      callbackChatId !== undefined &&
      callbackChatType === "private" &&
      callbackQuery.from.id !== callbackChatId
    ) {
      res.status(200).json({
        ok: true,
        processed: true,
        callbackHandled: false,
        reason: "Callback ownership mismatch.",
      });
      return;
    }

    const callbackAnswerResult = await answerTelegramCallbackQuery({
      callbackQueryId: callbackQuery.id,
      text:
        purchaseAction !== null
          ? purchaseAction.kind === "plan"
            ? "Opening payment..."
            : "Opening section..."
          : countriesAction !== null
            ? countriesAction.kind === "country"
              ? "Loading VPS list..."
              : "Sending configs..."
            : howToAction !== null
              ? "Opening guide..."
              : menuKey === null
                ? "Unknown action."
                : menuKey === "subscription_status"
                  ? "Fetching subscription status..."
                  : menuKey === "countries"
                    ? "Loading countries..."
                    : menuKey === "how_to_use"
                      ? "Opening platforms..."
                      : "Opening section...",
      showAlert: false,
    });

    if (!callbackAnswerResult.ok) {
      console.error(
        "Failed to answer Telegram callback query:",
        callbackAnswerResult.statusCode,
        callbackAnswerResult.error,
      );
    }

    if (
      menuKey === null &&
      purchaseAction === null &&
      countriesAction === null &&
      howToAction === null
    ) {
      res.status(200).json({
        ok: true,
        processed: true,
        callbackHandled: false,
      });
      return;
    }

    if (callbackChatId === undefined) {
      res.status(200).json({
        ok: true,
        processed: true,
        callbackHandled: false,
        reason: "Callback chat is missing.",
      });
      return;
    }

    if (purchaseAction !== null) {
      if (purchaseAction.kind === "open") {
        const paymentOptionsResult = await sendTelegramInlineMenuMessage({
          chatId: callbackChatId,
          text: "Choose payment method:",
          inlineKeyboardRows: [
            [{ text: "⭐ Telegram Stars", callbackData: "buy:method:tg_stars" }],
            [{ text: "TBD", callbackData: "buy:method:tbd_1" }],
            [{ text: "TBD", callbackData: "buy:method:tbd_2" }],
          ],
        });

        if (!paymentOptionsResult.ok) {
          console.error(
            "Failed to send payment methods message:",
            paymentOptionsResult.statusCode,
            paymentOptionsResult.error,
          );
        }

        res.status(200).json({
          ok: true,
          processed: true,
          callbackHandled: true,
          sent: paymentOptionsResult.ok,
        });
        return;
      }

      if (purchaseAction.kind === "method") {
        if (purchaseAction.method === "tg_stars") {
          const planOptionsResult = await sendTelegramInlineMenuMessage({
            chatId: callbackChatId,
            text: "Choose Telegram Stars plan:",
            inlineKeyboardRows: [
              [{ text: "1 month • 1 ⭐", callbackData: "buy:plan:1" }],
              [{ text: "3 months • 3 ⭐", callbackData: "buy:plan:3" }],
              [{ text: "6 months • 6 ⭐", callbackData: "buy:plan:6" }],
              [{ text: "12 months • 12 ⭐", callbackData: "buy:plan:12" }],
            ],
          });

          if (!planOptionsResult.ok) {
            console.error(
              "Failed to send stars plan options:",
              planOptionsResult.statusCode,
              planOptionsResult.error,
            );
          }

          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent: planOptionsResult.ok,
          });
          return;
        }

        const tbdResult = await sendTelegramTextMessage({
          chatId: callbackChatId,
          text: "This payment method is not implemented yet.",
        });

        if (!tbdResult.ok) {
          console.error(
            "Failed to send TBD payment method message:",
            tbdResult.statusCode,
            tbdResult.error,
          );
        }

        res.status(200).json({
          ok: true,
          processed: true,
          callbackHandled: true,
          sent: tbdResult.ok,
        });
        return;
      }

      const invoiceResult = await sendTelegramStarsInvoice({
        chatId: callbackChatId,
        title: "VPN " + String(purchaseAction.months) + " month plan",
        description:
          "Telegram Stars payment for " +
          String(purchaseAction.months) +
          " month VPN subscription.",
        payload: buildSubscriptionInvoicePayload(callbackQuery.from.id, purchaseAction.months),
        amount: purchaseAction.months,
      });

      if (!invoiceResult.ok) {
        console.error(
          "Failed to send Telegram Stars invoice:",
          invoiceResult.statusCode,
          invoiceResult.error,
        );
      }

      res.status(200).json({
        ok: true,
        processed: true,
        callbackHandled: true,
        invoiceSent: invoiceResult.ok,
      });
      return;
    }

    if (menuKey === "how_to_use") {
      const howToMenuResult = await sendTelegramInlineMenuMessage({
        chatId: callbackChatId,
        text: "Выберите устройство:",
        inlineKeyboardRows: [
          [{ text: "🍎 iOS", callbackData: "howto:ios" }],
          [{ text: "🤖 Android", callbackData: "howto:android" }],
          [{ text: "💻 macOS", callbackData: "howto:macos" }],
          [{ text: "🪟 Windows", callbackData: "howto:windows" }],
          [{ text: "📺 Android TV", callbackData: "howto:android_tv" }],
        ],
      });

      if (!howToMenuResult.ok) {
        console.error(
          "Failed to send how-to platform buttons:",
          howToMenuResult.statusCode,
          howToMenuResult.error,
        );
      }

      res.status(200).json({
        ok: true,
        processed: true,
        callbackHandled: true,
        sent: howToMenuResult.ok,
      });
      return;
    }

    if (howToAction !== null) {
      if (howToAction.platform === "android") {
        const androidGuideCaption = [
          "Скачай приложение для андроида по ссылке:",
          "https://play.google.com/store/apps/details?id=com.v2raytun.android",
          "",
          "Если у тебя нет PlayMarket - скачай приложение здесь:",
          "https://apkpure.com/ru/v2raytun/com.v2raytun.android",
          "",
          "Скопируй свою ссылку на VPN",
          "И подключись по инструкции с картинки",
        ].join("\n");
        const androidGuideImageUrl = "https://ibb.co/TDF1rD6F";
        const androidGuideResult = await sendTelegramPhotoMessage({
          chatId: callbackChatId,
          photoUrl: androidGuideImageUrl,
          caption: androidGuideCaption,
        });

        if (!androidGuideResult.ok) {
          console.error(
            "Failed to send android how-to image:",
            androidGuideResult.statusCode,
            androidGuideResult.error,
          );
          const androidGuideFallbackResult = await sendTelegramTextMessage({
            chatId: callbackChatId,
            text: [androidGuideImageUrl, "", androidGuideCaption].join("\n"),
          });

          if (!androidGuideFallbackResult.ok) {
            console.error(
              "Failed to send android how-to fallback message:",
              androidGuideFallbackResult.statusCode,
              androidGuideFallbackResult.error,
            );
          }

          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent: androidGuideFallbackResult.ok,
          });
          return;
        }

        res.status(200).json({
          ok: true,
          processed: true,
          callbackHandled: true,
          sent: true,
        });
        return;
      }

      const guideResult = await sendTelegramTextMessage({
        chatId: callbackChatId,
        text:
          "Инструкция для " +
          getHowToPlatformLabel(howToAction.platform) +
          " скоро будет доступна.",
      });

      if (!guideResult.ok) {
        console.error(
          "Failed to send how-to platform message:",
          guideResult.statusCode,
          guideResult.error,
        );
      }

      res.status(200).json({
        ok: true,
        processed: true,
        callbackHandled: true,
        sent: guideResult.ok,
      });
      return;
    }

    if (menuKey === "countries") {
      try {
        const telegramUser = await getTelegramUserByTgId(String(callbackQuery.from.id));
        const hasServersAccess =
          telegramUser !== null &&
          hasAccessToServers(telegramUser.subscription_status, telegramUser.subscription_active);

        if (!hasServersAccess) {
          const purchaseOptionsResult =
            await sendSubscriptionRequiredForServersMessage(callbackChatId);

          if (!purchaseOptionsResult.ok) {
            console.error(
              "Failed to send subscription required message for countries:",
              purchaseOptionsResult.statusCode,
              purchaseOptionsResult.error,
            );
          }

          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent: purchaseOptionsResult.ok,
          });
          return;
        }

        const countries = await listUniqueVpsCountries();

        const countriesResult =
          countries.length === 0
            ? await sendTelegramTextMessage({
                chatId: callbackChatId,
                text: "Список стран пока пуст.",
              })
            : await sendTelegramInlineMenuMessage({
                chatId: callbackChatId,
                text: "Список стран:",
                inlineKeyboardRows: countries.map((countryOption) => [
                  {
                    text: countryOption.country + " " + countryOption.countryEmoji,
                    callbackData: "countries:country:" + encodeCallbackValue(countryOption.country),
                  },
                ]),
              });

        if (!countriesResult.ok) {
          console.error(
            "Failed to send countries list message:",
            countriesResult.statusCode,
            countriesResult.error,
          );
        }

        res.status(200).json({
          ok: true,
          processed: true,
          callbackHandled: true,
          sent: countriesResult.ok,
        });
        return;
      } catch (error) {
        console.error("Failed to fetch countries list from DB:", error);
        res.status(200).json({
          ok: true,
          processed: true,
          callbackHandled: true,
          sent: false,
        });
        return;
      }
    }

    if (countriesAction !== null) {
      const telegramUser = await getTelegramUserByTgId(String(callbackQuery.from.id));
      const hasServersAccess =
        telegramUser !== null &&
        hasAccessToServers(telegramUser.subscription_status, telegramUser.subscription_active);

      if (!hasServersAccess) {
        const purchaseOptionsResult =
          await sendSubscriptionRequiredForServersMessage(callbackChatId);

        if (!purchaseOptionsResult.ok) {
          console.error(
            "Failed to send subscription required message for countries action:",
            purchaseOptionsResult.statusCode,
            purchaseOptionsResult.error,
          );
        }

        res.status(200).json({
          ok: true,
          processed: true,
          callbackHandled: true,
          sent: purchaseOptionsResult.ok,
        });
        return;
      }

      if (countriesAction.kind === "country") {
        try {
          const vpsList = await listVpsByCountry(countriesAction.country);

          const vpsListResult =
            vpsList.length === 0
              ? await sendTelegramTextMessage({
                  chatId: callbackChatId,
                  text: "Для страны " + countriesAction.country + " серверы пока не добавлены.",
                })
              : await sendTelegramInlineMenuMessage({
                  chatId: callbackChatId,
                  text: "Серверы в " + countriesAction.country + ":",
                  inlineKeyboardRows: vpsList.map((vpsItem) => [
                    {
                      text:
                        vpsItem.nickname ?? "VPS " + vpsItem.internalUuid.slice(0, 8).toUpperCase(),
                      callbackData: "countries:vps:" + vpsItem.internalUuid,
                    },
                  ]),
                });

          if (!vpsListResult.ok) {
            console.error(
              "Failed to send VPS list for country:",
              vpsListResult.statusCode,
              vpsListResult.error,
            );
          }

          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent: vpsListResult.ok,
          });
          return;
        } catch (error) {
          console.error("Failed to fetch VPS by country:", error);
          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent: false,
          });
          return;
        }
      }

      try {
        const vpsConfig = await getVpsConfigByInternalUuid(countriesAction.internalUuid);

        const configResult =
          vpsConfig === null
            ? await sendTelegramTextMessage({
                chatId: callbackChatId,
                text: "Конфигурация сервера не найдена.",
              })
            : vpsConfig.configList.length === 0
              ? await sendTelegramTextMessage({
                  chatId: callbackChatId,
                  text: "Для этого сервера пока нет конфигов.",
                })
              : await sendTelegramTextMessage({
                  chatId: callbackChatId,
                  text: ["Ссылки для приложения:", vpsConfig.configList.join("\n\n")].join("\n\n"),
                });

        if (!configResult.ok) {
          console.error(
            "Failed to send VPS config list:",
            configResult.statusCode,
            configResult.error,
          );
        }

        res.status(200).json({
          ok: true,
          processed: true,
          callbackHandled: true,
          sent: configResult.ok,
        });
        return;
      } catch (error) {
        console.error("Failed to fetch VPS config list:", error);
        res.status(200).json({
          ok: true,
          processed: true,
          callbackHandled: true,
          sent: false,
        });
        return;
      }
    }

    if (menuKey === "subscription_status") {
      try {
        const telegramUser = await getTelegramUserByTgId(String(callbackQuery.from.id));
        const isSubscriptionMissing =
          telegramUser === null ||
          (telegramUser.subscription_status === null && !telegramUser.subscription_active);
        const statusText = isSubscriptionMissing
          ? "🔴 SUBSCRIPTION STATUS: NOT FOUND\nYou can purchase subscription below."
          : buildSubscriptionStatusTextFromDb(
              telegramUser.subscription_status,
              telegramUser.subscription_untill,
            );

        const statusMessageResult = isSubscriptionMissing
          ? await sendTelegramInlineMenuMessage({
              chatId: callbackChatId,
              text: statusText,
              inlineKeyboardRows: [
                [{ text: "🛒 Purchase subscription", callbackData: "buy:open" }],
              ],
            })
          : await sendTelegramTextMessage({
              chatId: callbackChatId,
              text: statusText,
            });

        if (!statusMessageResult.ok) {
          console.error(
            "Failed to send subscription status message:",
            statusMessageResult.statusCode,
            statusMessageResult.error,
          );
        }

        res.status(200).json({
          ok: true,
          processed: true,
          callbackHandled: true,
          sent: statusMessageResult.ok,
        });
        return;
      } catch (error) {
        console.error("Failed to fetch subscription status from DB:", error);
        res.status(200).json({
          ok: true,
          processed: true,
          callbackHandled: true,
          sent: false,
        });
        return;
      }
    }

    if (callbackMessageId === undefined) {
      res.status(200).json({
        ok: true,
        processed: true,
        callbackHandled: false,
      });
      return;
    }

    if (menuKey === null) {
      res.status(200).json({
        ok: true,
        processed: true,
        callbackHandled: false,
      });
      return;
    }

    const menuPayload = buildTelegramMenu("unknown");
    const editResult = await editTelegramInlineMenuMessage({
      chatId: callbackChatId,
      messageId: callbackMessageId,
      text: getMenuSectionText(menuKey),
      inlineKeyboardRows: menuPayload.inlineKeyboardRows,
    });

    if (!editResult.ok) {
      console.error(
        "Failed to edit Telegram menu message:",
        editResult.statusCode,
        editResult.error,
      );
    }

    res.status(200).json({
      ok: true,
      processed: true,
      callbackHandled: true,
      edited: editResult.ok,
    });
    return;
  }

  const message = parsedUpdate.data.message ?? parsedUpdate.data.edited_message;

  if (message === undefined) {
    res.status(200).json({
      ok: true,
      processed: false,
      reason: "No message in update.",
    });
    return;
  }

  if (message.successful_payment !== undefined) {
    if (message.from === undefined) {
      res.status(200).json({
        ok: true,
        processed: false,
        reason: "Payment update is missing sender.",
      });
      return;
    }

    const paymentPayload = parseSubscriptionInvoicePayload(
      message.successful_payment.invoice_payload,
    );
    if (paymentPayload === null) {
      const invalidPaymentResult = await sendTelegramTextMessage({
        chatId: message.chat.id,
        text: "Payment received but validation failed. Please contact support.",
      });

      if (!invalidPaymentResult.ok) {
        console.error(
          "Failed to send invalid payment message:",
          invalidPaymentResult.statusCode,
          invalidPaymentResult.error,
        );
      }

      res.status(200).json({
        ok: true,
        processed: true,
        paymentApplied: false,
      });
      return;
    }

    const paymentIsValid =
      message.successful_payment.currency === "XTR" &&
      message.successful_payment.total_amount === paymentPayload.months &&
      paymentPayload.tgId === String(message.from.id);

    if (!paymentIsValid) {
      const invalidPaymentResult = await sendTelegramTextMessage({
        chatId: message.chat.id,
        text: "Payment received but validation failed. Please contact support.",
      });

      if (!invalidPaymentResult.ok) {
        console.error(
          "Failed to send invalid payment message:",
          invalidPaymentResult.statusCode,
          invalidPaymentResult.error,
        );
      }

      res.status(200).json({
        ok: true,
        processed: true,
        paymentApplied: false,
      });
      return;
    }

    try {
      const updatedUser = await activateTelegramSubscription({
        tgId: String(message.from.id),
        tgNickname: message.from.username ?? null,
        months: paymentPayload.months,
      });

      const paymentSuccessResult = await sendTelegramTextMessage({
        chatId: message.chat.id,
        text: [
          "✅ Payment successful via Telegram Stars.",
          "Plan: " +
            String(paymentPayload.months) +
            " month" +
            (paymentPayload.months === 1 ? "" : "s") +
            ".",
          "🟢 SUBSCRIPTION STATUS: LIVE",
          updatedUser.subscription_untill
            ? "Valid until: " + updatedUser.subscription_untill
            : null,
        ]
          .filter((line): line is string => line !== null)
          .join("\n"),
      });

      if (!paymentSuccessResult.ok) {
        console.error(
          "Failed to send successful payment confirmation:",
          paymentSuccessResult.statusCode,
          paymentSuccessResult.error,
        );
      }

      res.status(200).json({
        ok: true,
        processed: true,
        paymentApplied: true,
      });
      return;
    } catch (error) {
      console.error("Failed to activate subscription after payment:", error);
      res.status(200).json({
        ok: true,
        processed: true,
        paymentApplied: false,
      });
      return;
    }
  }

  if (message.chat.type !== undefined && message.chat.type !== "private") {
    res.status(200).json({
      ok: true,
      processed: false,
      reason: "Only private chat commands are handled.",
    });
    return;
  }

  if (message.from !== undefined && message.from.id !== message.chat.id) {
    res.status(200).json({
      ok: true,
      processed: false,
      reason: "Sender/chat mismatch detected.",
    });
    return;
  }

  const parsedCommand = getTelegramCommand(message.text);

  if (parsedCommand.isSuspicious) {
    res.status(200).json({
      ok: true,
      processed: false,
      blocked: true,
      reason: parsedCommand.reason ?? "Blocked by security policy.",
    });
    return;
  }

  const command = parsedCommand.command;

  if (command !== "/start" && command !== "/menu") {
    res.status(200).json({
      ok: true,
      processed: false,
      reason: "Command is not handled.",
    });
    return;
  }

  if (message.from === undefined) {
    res.status(200).json({
      ok: true,
      processed: false,
      reason: "Telegram user context is missing.",
    });
    return;
  }

  let userSyncResult: Awaited<ReturnType<typeof ensureTelegramUser>>;

  try {
    userSyncResult = await ensureTelegramUser({
      tgId: String(message.from.id),
      tgNickname: message.from.username ?? null,
    });
  } catch (error) {
    console.error("Failed to sync Telegram user:", error);
    res.status(200).json({
      ok: true,
      processed: false,
      reason: "Failed to sync user profile.",
    });
    return;
  }

  const menuSubscriptionStatus = mapTelegramUserToMenuSubscriptionStatus(userSyncResult.user);
  const menuPayload = buildTelegramMenu(menuSubscriptionStatus);
  const isStartCommand = command === "/start";

  const telegramSendResult = await sendTelegramInlineMenuMessage({
    chatId: message.chat.id,
    text: isStartCommand
      ? userSyncResult.created
        ? "Welcome to Uskoritel Interneta VPN. Your profile is created."
        : "Welcome back to Uskoritel Interneta VPN."
      : "Main menu:",
    inlineKeyboardRows: menuPayload.inlineKeyboardRows,
  });

  if (!telegramSendResult.ok) {
    console.error(
      "Failed to send Telegram menu:",
      telegramSendResult.statusCode,
      telegramSendResult.error,
    );
  }

  res.status(200).json({
    ok: true,
    processed: true,
    command,
    sent: telegramSendResult.ok,
  });
}
