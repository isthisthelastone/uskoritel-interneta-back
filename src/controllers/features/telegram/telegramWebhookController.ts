import type { Request, Response } from "express";
import { z } from "zod";
import {
  answerTelegramCallbackQuery,
  answerTelegramPreCheckoutQuery,
  clearTelegramChatHistoryBySweep,
  editTelegramInlineMenuMessage,
  sendTelegramInlineMenuMessage,
  sendTelegramStarsInvoice,
  sendTelegramTextMessage,
} from "../../../services/telegramBotService";
import { buildTelegramMenu } from "../../../services/telegramMenuService";
import {
  activateTelegramGift,
  activateTelegramSubscriptionFromBalance,
  addTelegramGift,
  applyPromoToTelegramUser,
  applyReferralRewardForPurchase,
  ensureTelegramUser,
  finalizeTelegramPaidSubscriptionPurchase,
  findTelegramUserByNickname,
  getTelegramUserByTgId,
  mapTelegramUserToMenuSubscriptionStatus,
} from "../../../services/telegramUserService";
import { getBlogerPromoByCode } from "../../../services/blogerPromoService";
import {
  getSubscriptionPriceByMonths,
  listSubscriptionPrices,
} from "../../../services/subscriptionPricingService";
import {
  issueOrGetUserVpsConfigUrls,
  listUniqueVpsCountries,
  listVpsByCountry,
} from "../../../services/vpsCatalogService";
import {
  buildGiftInvoicePayload,
  buildSubscriptionInvoicePayload,
  buildSubscriptionStatusTextFromDb,
  encodeCountryCallbackValue,
  getCountriesActionFromCallbackData,
  getFaqActionFromCallbackData,
  getFaqActionText,
  getFaqMenuInlineKeyboardRows,
  getHowToActionFromCallbackData,
  getGiftsActionFromCallbackData,
  getMenuKeyFromCallbackData,
  getMenuSectionText,
  getPurchaseActionFromCallbackData,
  getReferalsActionFromCallbackData,
  getTelegramCommand,
  hasAccessToServers,
  parseSubscriptionInvoicePayload,
  sendSubscriptionRequiredForServersMessage,
} from "../../entities";
import { handleHowToGuideAction } from "./howToGuideHandler";

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

const pendingGiftRecipientInputByTgId = new Map<string, number>();
const pendingPromoInputByTgId = new Map<string, number>();
const pendingGiftRecipientInputTtlMs = 15 * 60 * 1000;
const pendingPromoInputTtlMs = 15 * 60 * 1000;
const clearQueueMaxPending = 5;
const clearQueueSweepLimit = 5000;
const clearQueueOverloadedErrorCode = "CLEAR_QUEUE_OVERLOADED";

interface ClearQueueTask {
  chatId: number;
  upToMessageId: number;
  resolve: (result: Awaited<ReturnType<typeof clearTelegramChatHistoryBySweep>>) => void;
  reject: (error: unknown) => void;
}

const clearQueueTasks: ClearQueueTask[] = [];
let isClearQueueWorkerRunning = false;

function startPendingGiftRecipientInput(tgId: string): void {
  pendingGiftRecipientInputByTgId.set(tgId, Date.now());
}

function clearPendingGiftRecipientInput(tgId: string): void {
  pendingGiftRecipientInputByTgId.delete(tgId);
}

function hasPendingGiftRecipientInput(tgId: string): boolean {
  const createdAt = pendingGiftRecipientInputByTgId.get(tgId);

  if (createdAt === undefined) {
    return false;
  }

  if (Date.now() - createdAt > pendingGiftRecipientInputTtlMs) {
    pendingGiftRecipientInputByTgId.delete(tgId);
    return false;
  }

  return true;
}

function startPendingPromoInput(tgId: string): void {
  pendingPromoInputByTgId.set(tgId, Date.now());
}

function clearPendingPromoInput(tgId: string): void {
  pendingPromoInputByTgId.delete(tgId);
}

function hasPendingPromoInput(tgId: string): boolean {
  const createdAt = pendingPromoInputByTgId.get(tgId);

  if (createdAt === undefined) {
    return false;
  }

  if (Date.now() - createdAt > pendingPromoInputTtlMs) {
    pendingPromoInputByTgId.delete(tgId);
    return false;
  }

  return true;
}

function getClearQueueLoad(): number {
  return clearQueueTasks.length + (isClearQueueWorkerRunning ? 1 : 0);
}

function runClearQueueWorker(): void {
  if (isClearQueueWorkerRunning) {
    return;
  }

  const nextTask = clearQueueTasks.shift();

  if (nextTask === undefined) {
    return;
  }

  isClearQueueWorkerRunning = true;

  void (async () => {
    try {
      const clearResult = await clearTelegramChatHistoryBySweep({
        chatId: nextTask.chatId,
        upToMessageId: nextTask.upToMessageId,
        maxMessagesToSweep: clearQueueSweepLimit,
      });
      nextTask.resolve(clearResult);
    } catch (error) {
      nextTask.reject(error);
    } finally {
      isClearQueueWorkerRunning = false;
      runClearQueueWorker();
    }
  })();
}

function enqueueClearChatHistory(params: {
  chatId: number;
  upToMessageId: number;
}): Promise<Awaited<ReturnType<typeof clearTelegramChatHistoryBySweep>>> {
  if (getClearQueueLoad() >= clearQueueMaxPending) {
    return Promise.reject(new Error(clearQueueOverloadedErrorCode));
  }

  return new Promise((resolve, reject) => {
    clearQueueTasks.push({
      chatId: params.chatId,
      upToMessageId: params.upToMessageId,
      resolve,
      reject,
    });
    runClearQueueWorker();
  });
}

function applyPercentDiscountToStars(baseAmount: number, discountPercent: number): number {
  const safeDiscount = Math.min(100, Math.max(0, Math.floor(discountPercent)));
  return Math.max(1, Math.round((baseAmount * (100 - safeDiscount)) / 100));
}

function applyPercentDiscountToUsd(baseAmount: number, discountPercent: number): number {
  const safeDiscount = Math.min(100, Math.max(0, Math.floor(discountPercent)));
  return Math.round(baseAmount * (100 - safeDiscount)) / 100;
}

async function resolveSubscriptionPurchaseAmount(
  tgId: string,
  months: number,
): Promise<{ starsAmount: number; usdAmount: number; discountPercent: number } | null> {
  const basePrice = await getSubscriptionPriceByMonths(months);

  if (basePrice === null) {
    return null;
  }

  let discountPercent = 0;
  const payerUser = await getTelegramUserByTgId(tgId);

  if (payerUser !== null && !payerUser.has_purchased && payerUser.current_discount > 0) {
    discountPercent = payerUser.current_discount;
  }

  return {
    starsAmount: applyPercentDiscountToStars(basePrice.stars, discountPercent),
    usdAmount: applyPercentDiscountToUsd(basePrice.usdt, discountPercent),
    discountPercent,
  };
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
    let isValidPayload = false;

    if (invoicePayload !== null && preCheckoutQuery.currency === "XTR") {
      if (invoicePayload.tgId !== String(preCheckoutQuery.from.id)) {
        isValidPayload = false;
      } else {
        try {
          if (invoicePayload.action === "gift") {
            const expectedPrice = await getSubscriptionPriceByMonths(invoicePayload.months);
            isValidPayload =
              expectedPrice !== null && preCheckoutQuery.total_amount === expectedPrice.stars;
          } else {
            const expectedPurchaseAmount = await resolveSubscriptionPurchaseAmount(
              invoicePayload.tgId,
              invoicePayload.months,
            );
            isValidPayload =
              expectedPurchaseAmount !== null &&
              preCheckoutQuery.total_amount === expectedPurchaseAmount.starsAmount;
          }
        } catch (error) {
          console.error("Failed to load price during pre-checkout validation:", error);
        }
      }
    }

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
    const faqAction = getFaqActionFromCallbackData(callbackQuery.data);
    const referalsAction = getReferalsActionFromCallbackData(callbackQuery.data);
    const giftsAction = getGiftsActionFromCallbackData(callbackQuery.data);
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
          : faqAction !== null
            ? "Opening answer..."
            : referalsAction !== null
              ? referalsAction.kind === "balance_plan"
                ? "Processing prolongation..."
                : "Opening referral section..."
              : giftsAction !== null
                ? giftsAction.kind === "activate"
                  ? "Activating gift..."
                  : giftsAction.kind === "plan"
                    ? "Opening payment..."
                    : "Opening gifts..."
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
                          : menuKey === "faq"
                            ? "Opening FAQ..."
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
      faqAction === null &&
      referalsAction === null &&
      giftsAction === null &&
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
          let planOptionsResult: Awaited<ReturnType<typeof sendTelegramInlineMenuMessage>>;

          try {
            const prices = await listSubscriptionPrices();
            const payerUser = await getTelegramUserByTgId(String(callbackQuery.from.id));
            const discountPercent =
              payerUser !== null && !payerUser.has_purchased && payerUser.current_discount > 0
                ? payerUser.current_discount
                : 0;

            if (prices.length === 0) {
              planOptionsResult = await sendTelegramTextMessage({
                chatId: callbackChatId,
                text: "Планы оплаты пока недоступны. Попробуйте позже.",
              });
            } else {
              planOptionsResult = await sendTelegramInlineMenuMessage({
                chatId: callbackChatId,
                text:
                  discountPercent > 0
                    ? "Choose Telegram Stars plan (скидка " + String(discountPercent) + "%):"
                    : "Choose Telegram Stars plan:",
                inlineKeyboardRows: prices.map((price) => [
                  {
                    text:
                      String(price.months) +
                      " " +
                      (price.months === 1 ? "month" : "months") +
                      " • " +
                      String(applyPercentDiscountToStars(price.stars, discountPercent)) +
                      " ⭐" +
                      (discountPercent > 0 ? " (-" + String(discountPercent) + "%)" : ""),
                    callbackData: "buy:plan:" + String(price.months),
                  },
                ]),
              });
            }
          } catch (error) {
            console.error("Failed to fetch stars plan options from DB:", error);
            planOptionsResult = await sendTelegramTextMessage({
              chatId: callbackChatId,
              text: "Не удалось загрузить тарифы. Попробуйте позже.",
            });
          }

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

      let selectedPurchaseAmount: Awaited<ReturnType<typeof resolveSubscriptionPurchaseAmount>>;

      try {
        selectedPurchaseAmount = await resolveSubscriptionPurchaseAmount(
          String(callbackQuery.from.id),
          purchaseAction.months,
        );
      } catch (error) {
        console.error("Failed to load selected plan from DB:", error);
        const loadPlanFailedResult = await sendTelegramTextMessage({
          chatId: callbackChatId,
          text: "Не удалось загрузить тариф. Попробуйте позже.",
        });

        if (!loadPlanFailedResult.ok) {
          console.error(
            "Failed to send plan load failure message:",
            loadPlanFailedResult.statusCode,
            loadPlanFailedResult.error,
          );
        }

        res.status(200).json({
          ok: true,
          processed: true,
          callbackHandled: true,
          invoiceSent: false,
        });
        return;
      }

      if (selectedPurchaseAmount === null) {
        const missingPlanResult = await sendTelegramTextMessage({
          chatId: callbackChatId,
          text: "Выбранный тариф недоступен. Обновите меню и попробуйте снова.",
        });

        if (!missingPlanResult.ok) {
          console.error(
            "Failed to send unavailable plan message:",
            missingPlanResult.statusCode,
            missingPlanResult.error,
          );
        }

        res.status(200).json({
          ok: true,
          processed: true,
          callbackHandled: true,
          invoiceSent: false,
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
        amount: selectedPurchaseAmount.starsAmount,
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

    if (menuKey === "faq") {
      const faqMenuResult = await sendTelegramInlineMenuMessage({
        chatId: callbackChatId,
        text: "Выберите вопрос:",
        inlineKeyboardRows: getFaqMenuInlineKeyboardRows(),
      });

      if (!faqMenuResult.ok) {
        console.error("Failed to send FAQ menu:", faqMenuResult.statusCode, faqMenuResult.error);
      }

      res.status(200).json({
        ok: true,
        processed: true,
        callbackHandled: true,
        sent: faqMenuResult.ok,
      });
      return;
    }

    if (faqAction !== null) {
      const faqText = getFaqActionText(faqAction.kind);

      const faqMessageResult = await sendTelegramTextMessage({
        chatId: callbackChatId,
        text: faqText,
      });

      if (!faqMessageResult.ok) {
        console.error(
          "Failed to send FAQ action message:",
          faqMessageResult.statusCode,
          faqMessageResult.error,
        );
      }

      res.status(200).json({
        ok: true,
        processed: true,
        callbackHandled: true,
        sent: faqMessageResult.ok,
      });
      return;
    }

    if (menuKey === "referals") {
      try {
        const telegramUser = await getTelegramUserByTgId(String(callbackQuery.from.id));

        if (telegramUser === null) {
          const noUserResult = await sendTelegramTextMessage({
            chatId: callbackChatId,
            text: "Профиль не найден. Используйте /start, затем попробуйте снова.",
          });

          if (!noUserResult.ok) {
            console.error(
              "Failed to send missing profile message for referrals:",
              noUserResult.statusCode,
              noUserResult.error,
            );
          }

          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent: noUserResult.ok,
          });
          return;
        }

        const botUsername = (process.env.BOT_USERNAME ?? "").replace(/^@/u, "");
        const referralLink =
          botUsername.length > 0
            ? "https://t.me/" + botUsername + "?start=ref_" + telegramUser.tg_id
            : "BOT_USERNAME не настроен";
        const totalEarnedUsd = telegramUser.earned_money.toFixed(2);

        const referralMessageResult = await sendTelegramInlineMenuMessage({
          chatId: callbackChatId,
          text: [
            "👥 Реферальная программа",
            "",
            "За каждого приглашенного клиента при первой оплате вы получаете 20%",
            "За каждую последующую ее продление 10%",
            "",
            "на заработанные деньги вы можете продлить свою подписку или вывести через USDT",
            "",
            "минимальная сумма вывода 5$",
            "",
            "Ваша реферальная ссылка:",
            referralLink,
            "",
            "• Всего заработано : " + totalEarnedUsd + "$",
            "• Количество ваших рефералов: " + String(telegramUser.number_of_referals),
          ].join("\n"),
          inlineKeyboardRows: [
            [{ text: "🔄 Продлить подписку", callbackData: "referals:prolong" }],
            [{ text: "💬 Связаться с поддержкой для вывода", url: "https://t.me/starlinkacc" }],
          ],
        });

        if (!referralMessageResult.ok) {
          console.error(
            "Failed to send referral program message:",
            referralMessageResult.statusCode,
            referralMessageResult.error,
          );
        }

        res.status(200).json({
          ok: true,
          processed: true,
          callbackHandled: true,
          sent: referralMessageResult.ok,
        });
        return;
      } catch (error) {
        console.error("Failed to render referral program section:", error);
        res.status(200).json({
          ok: true,
          processed: true,
          callbackHandled: true,
          sent: false,
        });
        return;
      }
    }

    if (referalsAction !== null) {
      if (referalsAction.kind === "prolong") {
        try {
          const telegramUser = await getTelegramUserByTgId(String(callbackQuery.from.id));

          if (telegramUser === null) {
            const noUserResult = await sendTelegramTextMessage({
              chatId: callbackChatId,
              text: "Профиль не найден. Используйте /start, затем попробуйте снова.",
            });

            if (!noUserResult.ok) {
              console.error(
                "Failed to send missing profile message for referrals prolongation:",
                noUserResult.statusCode,
                noUserResult.error,
              );
            }

            res.status(200).json({
              ok: true,
              processed: true,
              callbackHandled: true,
              sent: noUserResult.ok,
            });
            return;
          }

          const prices = await listSubscriptionPrices();
          const affordablePrices = prices.filter(
            (price) => price.usdt <= telegramUser.earned_money,
          );

          if (affordablePrices.length === 0) {
            const notEnoughResult = await sendTelegramTextMessage({
              chatId: callbackChatId,
              text: "Пока что недостаточно средств для оплаты подписки.",
            });

            if (!notEnoughResult.ok) {
              console.error(
                "Failed to send insufficient referral balance message:",
                notEnoughResult.statusCode,
                notEnoughResult.error,
              );
            }

            res.status(200).json({
              ok: true,
              processed: true,
              callbackHandled: true,
              sent: notEnoughResult.ok,
            });
            return;
          }

          const prolongMenuResult = await sendTelegramInlineMenuMessage({
            chatId: callbackChatId,
            text:
              "Выберите период продления за реферальный баланс.\nТекущий баланс: " +
              telegramUser.earned_money.toFixed(2) +
              "$",
            inlineKeyboardRows: affordablePrices.map((price) => [
              {
                text:
                  String(price.months) +
                  " " +
                  (price.months === 1 ? "месяц" : "месяцев") +
                  " • " +
                  price.usdt.toFixed(2) +
                  "$",
                callbackData: "referals:balance_plan:" + String(price.months),
              },
            ]),
          });

          if (!prolongMenuResult.ok) {
            console.error(
              "Failed to send referral prolongation options:",
              prolongMenuResult.statusCode,
              prolongMenuResult.error,
            );
          }

          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent: prolongMenuResult.ok,
          });
          return;
        } catch (error) {
          console.error("Failed to build referral prolongation menu:", error);
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
        const selectedPrice = await getSubscriptionPriceByMonths(referalsAction.months);

        if (selectedPrice === null) {
          const missingPlanResult = await sendTelegramTextMessage({
            chatId: callbackChatId,
            text: "Выбранный тариф недоступен. Попробуйте снова.",
          });

          if (!missingPlanResult.ok) {
            console.error(
              "Failed to send missing plan message for referral prolongation:",
              missingPlanResult.statusCode,
              missingPlanResult.error,
            );
          }

          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent: missingPlanResult.ok,
          });
          return;
        }

        const updatedUser = await activateTelegramSubscriptionFromBalance({
          tgId: String(callbackQuery.from.id),
          tgNickname: null,
          months: referalsAction.months,
          amountUsd: selectedPrice.usdt,
        });

        try {
          await applyReferralRewardForPurchase({
            payerTgId: String(callbackQuery.from.id),
            payerTgNickname: updatedUser.tg_nickname,
            purchaseAmountUsd: selectedPrice.usdt,
          });
        } catch (rewardError) {
          console.error("Failed to apply referral reward after balance prolongation:", rewardError);
        }

        const successResult = await sendTelegramTextMessage({
          chatId: callbackChatId,
          text: [
            "✅ Подписка успешно продлена за реферальный баланс.",
            "Период: " + String(referalsAction.months) + " мес.",
            "Списано: " + selectedPrice.usdt.toFixed(2) + "$",
            "Остаток баланса: " + updatedUser.earned_money.toFixed(2) + "$",
            updatedUser.subscription_untill
              ? "Подписка до: " + updatedUser.subscription_untill
              : null,
          ]
            .filter((line): line is string => line !== null)
            .join("\n"),
        });

        if (!successResult.ok) {
          console.error(
            "Failed to send referral prolongation success message:",
            successResult.statusCode,
            successResult.error,
          );
        }

        res.status(200).json({
          ok: true,
          processed: true,
          callbackHandled: true,
          sent: successResult.ok,
        });
        return;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "";
        const isInsufficient = errorMessage.includes("INSUFFICIENT_REFERRAL_BALANCE");

        const failedResult = await sendTelegramTextMessage({
          chatId: callbackChatId,
          text: isInsufficient
            ? "Пока что недостаточно средств для оплаты подписки."
            : "Не удалось продлить подписку с реферального баланса. Попробуйте позже.",
        });

        if (!failedResult.ok) {
          console.error(
            "Failed to send referral prolongation failure message:",
            failedResult.statusCode,
            failedResult.error,
          );
        }

        if (!isInsufficient) {
          console.error("Failed to process referral prolongation payment:", error);
        }

        res.status(200).json({
          ok: true,
          processed: true,
          callbackHandled: true,
          sent: failedResult.ok,
        });
        return;
      }
    }

    if (menuKey === "gifts") {
      const giftsMenuResult = await sendTelegramInlineMenuMessage({
        chatId: callbackChatId,
        text: "🎁 Подарки и промокоды",
        inlineKeyboardRows: [
          [{ text: "🎁 Мои подарки", callbackData: "gift:my" }],
          [{ text: "🎉 Подарить подарок", callbackData: "gift:give" }],
          [{ text: "🏷️ Активировать промокод", callbackData: "gift:promo" }],
        ],
      });

      if (!giftsMenuResult.ok) {
        console.error(
          "Failed to send gifts menu:",
          giftsMenuResult.statusCode,
          giftsMenuResult.error,
        );
      }

      res.status(200).json({
        ok: true,
        processed: true,
        callbackHandled: true,
        sent: giftsMenuResult.ok,
      });
      return;
    }

    if (giftsAction !== null) {
      if (giftsAction.kind === "give") {
        startPendingGiftRecipientInput(String(callbackQuery.from.id));

        const promptResult = await sendTelegramTextMessage({
          chatId: callbackChatId,
          text: "Введите логин пользователя в тг вместе с @:",
        });

        if (!promptResult.ok) {
          console.error(
            "Failed to send gift recipient prompt:",
            promptResult.statusCode,
            promptResult.error,
          );
        }

        res.status(200).json({
          ok: true,
          processed: true,
          callbackHandled: true,
          sent: promptResult.ok,
        });
        return;
      }

      if (giftsAction.kind === "promo") {
        try {
          const telegramUser = await getTelegramUserByTgId(String(callbackQuery.from.id));

          if (telegramUser === null) {
            const noUserResult = await sendTelegramTextMessage({
              chatId: callbackChatId,
              text: "Профиль не найден. Используйте /start, затем попробуйте снова.",
            });

            if (!noUserResult.ok) {
              console.error(
                "Failed to send missing profile message for promo activation:",
                noUserResult.statusCode,
                noUserResult.error,
              );
            }

            res.status(200).json({
              ok: true,
              processed: true,
              callbackHandled: true,
              sent: noUserResult.ok,
            });
            return;
          }

          if (telegramUser.has_purchased) {
            const alreadyPurchasedResult = await sendTelegramTextMessage({
              chatId: callbackChatId,
              text: "Промокод работает только на первую покупку",
            });

            if (!alreadyPurchasedResult.ok) {
              console.error(
                "Failed to send promo first-purchase restriction message:",
                alreadyPurchasedResult.statusCode,
                alreadyPurchasedResult.error,
              );
            }

            res.status(200).json({
              ok: true,
              processed: true,
              callbackHandled: true,
              sent: alreadyPurchasedResult.ok,
            });
            return;
          }

          startPendingPromoInput(String(callbackQuery.from.id));

          const promoPromptResult = await sendTelegramTextMessage({
            chatId: callbackChatId,
            text: "Введите промокод:",
          });

          if (!promoPromptResult.ok) {
            console.error(
              "Failed to send promo input prompt:",
              promoPromptResult.statusCode,
              promoPromptResult.error,
            );
          }

          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent: promoPromptResult.ok,
          });
          return;
        } catch (error) {
          console.error("Failed to start promo activation flow:", error);
          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent: false,
          });
          return;
        }
      }

      if (giftsAction.kind === "my") {
        try {
          const telegramUser = await getTelegramUserByTgId(String(callbackQuery.from.id));

          if (telegramUser === null || telegramUser.gifts.length === 0) {
            const noGiftsResult = await sendTelegramInlineMenuMessage({
              chatId: callbackChatId,
              text: "У вас пока еще нет подарков",
              inlineKeyboardRows: [
                [{ text: "🎉 Подарить подарок", callbackData: "gift:give" }],
                [{ text: "🏷️ Активировать промокод", callbackData: "gift:promo" }],
              ],
            });

            if (!noGiftsResult.ok) {
              console.error(
                "Failed to send empty gifts message:",
                noGiftsResult.statusCode,
                noGiftsResult.error,
              );
            }

            res.status(200).json({
              ok: true,
              processed: true,
              callbackHandled: true,
              sent: noGiftsResult.ok,
            });
            return;
          }

          const giftsListResult = await sendTelegramInlineMenuMessage({
            chatId: callbackChatId,
            text: "Ваши подарки:",
            inlineKeyboardRows: [
              ...telegramUser.gifts.map((gift, giftIndex) => [
                {
                  text:
                    "🎁 Подарок на " +
                    String(gift.timeAmountGifted) +
                    " мес. от " +
                    (gift.giftedByTgName ?? "Unknown"),
                  callbackData: "gift:view:" + String(giftIndex),
                },
              ]),
              [{ text: "🎉 Подарить подарок", callbackData: "gift:give" }],
              [{ text: "🏷️ Активировать промокод", callbackData: "gift:promo" }],
            ],
          });

          if (!giftsListResult.ok) {
            console.error(
              "Failed to send gifts list:",
              giftsListResult.statusCode,
              giftsListResult.error,
            );
          }

          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent: giftsListResult.ok,
          });
          return;
        } catch (error) {
          console.error("Failed to fetch gifts list:", error);
          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent: false,
          });
          return;
        }
      }

      if (giftsAction.kind === "view") {
        try {
          const telegramUser = await getTelegramUserByTgId(String(callbackQuery.from.id));
          const selectedGift = telegramUser?.gifts[giftsAction.giftIndex];

          if (selectedGift === undefined) {
            const missingGiftResult = await sendTelegramTextMessage({
              chatId: callbackChatId,
              text: "Подарок не найден.",
            });

            if (!missingGiftResult.ok) {
              console.error(
                "Failed to send missing gift message:",
                missingGiftResult.statusCode,
                missingGiftResult.error,
              );
            }

            res.status(200).json({
              ok: true,
              processed: true,
              callbackHandled: true,
              sent: missingGiftResult.ok,
            });
            return;
          }

          const giftDetailsResult = await sendTelegramInlineMenuMessage({
            chatId: callbackChatId,
            text: [
              "🎁 Подарок на " + String(selectedGift.timeAmountGifted) + " мес.",
              "От: " + (selectedGift.giftedByTgName ?? "Unknown"),
              "Дата: " + selectedGift.dateOfGift,
            ].join("\n"),
            inlineKeyboardRows: [
              [
                {
                  text: "✅ Активировать подарок",
                  callbackData: "gift:activate:" + String(giftsAction.giftIndex),
                },
              ],
              [{ text: "⬅️ Назад", callbackData: "gift:my" }],
            ],
          });

          if (!giftDetailsResult.ok) {
            console.error(
              "Failed to send gift details message:",
              giftDetailsResult.statusCode,
              giftDetailsResult.error,
            );
          }

          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent: giftDetailsResult.ok,
          });
          return;
        } catch (error) {
          console.error("Failed to open gift details:", error);
          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent: false,
          });
          return;
        }
      }

      if (giftsAction.kind === "activate") {
        try {
          const activationResult = await activateTelegramGift({
            tgId: String(callbackQuery.from.id),
            tgNickname: null,
            giftIndex: giftsAction.giftIndex,
          });

          const giftActivatedMessageResult = await sendTelegramTextMessage({
            chatId: callbackChatId,
            text: [
              "✅ Подарок активирован.",
              "Продлено на: " + String(activationResult.activatedGift.timeAmountGifted) + " мес.",
              activationResult.user.subscription_untill
                ? "Подписка до: " + activationResult.user.subscription_untill
                : null,
            ]
              .filter((line): line is string => line !== null)
              .join("\n"),
          });

          if (!giftActivatedMessageResult.ok) {
            console.error(
              "Failed to send gift activation success message:",
              giftActivatedMessageResult.statusCode,
              giftActivatedMessageResult.error,
            );
          }

          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent: giftActivatedMessageResult.ok,
          });
          return;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "";
          const giftNotFound = errorMessage.includes("GIFT_NOT_FOUND");

          const giftActivateFailedResult = await sendTelegramTextMessage({
            chatId: callbackChatId,
            text: giftNotFound
              ? "Подарок не найден."
              : "Не удалось активировать подарок. Попробуйте позже.",
          });

          if (!giftActivateFailedResult.ok) {
            console.error(
              "Failed to send gift activation failure message:",
              giftActivateFailedResult.statusCode,
              giftActivateFailedResult.error,
            );
          }

          if (!giftNotFound) {
            console.error("Failed to activate gift:", error);
          }

          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent: giftActivateFailedResult.ok,
          });
          return;
        }
      }

      if (giftsAction.kind === "method") {
        if (giftsAction.method === "tg_stars") {
          try {
            const recipientUser = await getTelegramUserByTgId(giftsAction.recipientTgId);

            if (recipientUser === null) {
              const recipientMissingResult = await sendTelegramTextMessage({
                chatId: callbackChatId,
                text: "Пользователь не найден.",
              });

              if (!recipientMissingResult.ok) {
                console.error(
                  "Failed to send missing gift recipient message:",
                  recipientMissingResult.statusCode,
                  recipientMissingResult.error,
                );
              }

              res.status(200).json({
                ok: true,
                processed: true,
                callbackHandled: true,
                sent: recipientMissingResult.ok,
              });
              return;
            }

            const prices = await listSubscriptionPrices();
            const giftPlansResult =
              prices.length === 0
                ? await sendTelegramTextMessage({
                    chatId: callbackChatId,
                    text: "Планы оплаты пока недоступны. Попробуйте позже.",
                  })
                : await sendTelegramInlineMenuMessage({
                    chatId: callbackChatId,
                    text:
                      "Выберите срок подарка для @" +
                      (recipientUser.tg_nickname ?? giftsAction.recipientTgId) +
                      ":",
                    inlineKeyboardRows: prices.map((price) => [
                      {
                        text:
                          String(price.months) +
                          " " +
                          (price.months === 1 ? "month" : "months") +
                          " • " +
                          String(price.stars) +
                          " ⭐",
                        callbackData:
                          "gift:plan:" + String(price.months) + ":" + giftsAction.recipientTgId,
                      },
                    ]),
                  });

            if (!giftPlansResult.ok) {
              console.error(
                "Failed to send gift stars plans:",
                giftPlansResult.statusCode,
                giftPlansResult.error,
              );
            }

            res.status(200).json({
              ok: true,
              processed: true,
              callbackHandled: true,
              sent: giftPlansResult.ok,
            });
            return;
          } catch (error) {
            console.error("Failed to build gift payment plans:", error);
            res.status(200).json({
              ok: true,
              processed: true,
              callbackHandled: true,
              sent: false,
            });
            return;
          }
        }

        const tbdGiftMethodResult = await sendTelegramTextMessage({
          chatId: callbackChatId,
          text: "This payment method is not implemented yet.",
        });

        if (!tbdGiftMethodResult.ok) {
          console.error(
            "Failed to send TBD gift payment method message:",
            tbdGiftMethodResult.statusCode,
            tbdGiftMethodResult.error,
          );
        }

        res.status(200).json({
          ok: true,
          processed: true,
          callbackHandled: true,
          sent: tbdGiftMethodResult.ok,
        });
        return;
      }

      try {
        const selectedPrice = await getSubscriptionPriceByMonths(giftsAction.months);

        if (selectedPrice === null) {
          const missingGiftPlanResult = await sendTelegramTextMessage({
            chatId: callbackChatId,
            text: "Выбранный тариф недоступен. Попробуйте снова.",
          });

          if (!missingGiftPlanResult.ok) {
            console.error(
              "Failed to send missing gift plan message:",
              missingGiftPlanResult.statusCode,
              missingGiftPlanResult.error,
            );
          }

          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            invoiceSent: false,
          });
          return;
        }

        const giftInvoiceResult = await sendTelegramStarsInvoice({
          chatId: callbackChatId,
          title: "VPN gift " + String(giftsAction.months) + " month plan",
          description:
            "Telegram Stars payment for " +
            String(giftsAction.months) +
            " month VPN gift subscription.",
          payload: buildGiftInvoicePayload(
            callbackQuery.from.id,
            giftsAction.recipientTgId,
            giftsAction.months,
          ),
          amount: selectedPrice.stars,
        });

        if (!giftInvoiceResult.ok) {
          console.error(
            "Failed to send gift invoice:",
            giftInvoiceResult.statusCode,
            giftInvoiceResult.error,
          );
        }

        res.status(200).json({
          ok: true,
          processed: true,
          callbackHandled: true,
          invoiceSent: giftInvoiceResult.ok,
        });
        return;
      } catch (error) {
        console.error("Failed to prepare gift invoice:", error);
        res.status(200).json({
          ok: true,
          processed: true,
          callbackHandled: true,
          invoiceSent: false,
        });
        return;
      }
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
      const sent = await handleHowToGuideAction(callbackChatId, howToAction.platform);
      res.status(200).json({
        ok: true,
        processed: true,
        callbackHandled: true,
        sent,
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
                    callbackData:
                      "countries:country:" + encodeCountryCallbackValue(countryOption.country),
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
        const vpsConfig = await issueOrGetUserVpsConfigUrls(
          countriesAction.internalUuid,
          telegramUser.internal_uuid,
        );

        let sent = true;

        if (vpsConfig === null) {
          const notFoundResult = await sendTelegramTextMessage({
            chatId: callbackChatId,
            text: "Конфигурация сервера не найдена.",
          });

          if (!notFoundResult.ok) {
            console.error(
              "Failed to send missing VPS config message:",
              notFoundResult.statusCode,
              notFoundResult.error,
            );
            sent = false;
          }
        } else {
          const introResult = await sendTelegramTextMessage({
            chatId: callbackChatId,
            text: "Ваши персональные ссылки для приложения:",
            protectContent: true,
          });

          if (!introResult.ok) {
            console.error(
              "Failed to send config intro message:",
              introResult.statusCode,
              introResult.error,
            );
            sent = false;
          }

          const configUrls = [vpsConfig.directUrl, vpsConfig.obfsUrl];

          for (const configUrl of configUrls) {
            const escapedConfigUrl = configUrl
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;");
            const configMessageResult = await sendTelegramTextMessage({
              chatId: callbackChatId,
              text: "<code>" + escapedConfigUrl + "</code>",
              protectContent: true,
              parseMode: "HTML",
            });

            if (!configMessageResult.ok) {
              console.error(
                "Failed to send protected VPS config URL:",
                configMessageResult.statusCode,
                configMessageResult.error,
              );
              sent = false;
            }
          }
        }

        res.status(200).json({
          ok: true,
          processed: true,
          callbackHandled: true,
          sent,
        });
        return;
      } catch (error) {
        console.error("Failed to issue VPS config list for user:", error);
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
          ? "🔴 Подписка не найдена\nНиже вы можете приобрести подписку."
          : buildSubscriptionStatusTextFromDb(
              telegramUser.subscription_status,
              telegramUser.subscription_untill,
            );

        const statusMessageResult = await sendTelegramInlineMenuMessage({
          chatId: callbackChatId,
          text: statusText,
          inlineKeyboardRows: [
            [
              {
                text: isSubscriptionMissing ? "🛒 Приобрести подписку" : "🔄 Продлить подписку",
                callbackData: "buy:open",
              },
            ],
          ],
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
        text: "Платеж получен, но произошла ошибка, свяжитесь с подержкой.",
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

    let paymentIsValid = false;
    let validatedUsdAmount = 0;

    if (message.successful_payment.currency === "XTR") {
      if (paymentPayload.tgId !== String(message.from.id)) {
        paymentIsValid = false;
      } else {
        try {
          if (paymentPayload.action === "gift") {
            const expectedGiftPrice = await getSubscriptionPriceByMonths(paymentPayload.months);
            paymentIsValid =
              expectedGiftPrice !== null &&
              message.successful_payment.total_amount === expectedGiftPrice.stars;

            if (paymentIsValid && expectedGiftPrice !== null) {
              validatedUsdAmount = expectedGiftPrice.usdt;
            }
          } else {
            const expectedPurchaseAmount = await resolveSubscriptionPurchaseAmount(
              paymentPayload.tgId,
              paymentPayload.months,
            );
            paymentIsValid =
              expectedPurchaseAmount !== null &&
              message.successful_payment.total_amount === expectedPurchaseAmount.starsAmount;

            if (paymentIsValid && expectedPurchaseAmount !== null) {
              validatedUsdAmount = expectedPurchaseAmount.usdAmount;
            }
          }
        } catch (error) {
          console.error("Failed to load price during successful payment validation:", error);
        }
      }
    }

    if (!paymentIsValid) {
      const invalidPaymentResult = await sendTelegramTextMessage({
        chatId: message.chat.id,
        text: "Платеж получен, но произошла ошибка, свяжитесь с подержкой.",
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
      if (paymentPayload.action === "gift") {
        const referDate = new Date().toISOString().slice(0, 10);
        const giftedRecipient = await addTelegramGift({
          recipientTgId: paymentPayload.recipientTgId,
          recipientTgNickname: null,
          giftedByTgId: String(message.from.id),
          giftedByTgName: message.from.username ?? null,
          timeAmountGifted: paymentPayload.months,
          setReferredByWhenUserCreated: {
            tgId: String(message.from.id),
            tgNickname: message.from.username ?? null,
            referDate,
          },
        });

        if (validatedUsdAmount > 0) {
          try {
            await applyReferralRewardForPurchase({
              payerTgId: String(message.from.id),
              payerTgNickname: message.from.username ?? null,
              purchaseAmountUsd: validatedUsdAmount,
            });
          } catch (rewardError) {
            console.error("Failed to apply referral reward after gift payment:", rewardError);
          }
        }

        const giftPaymentSuccessResult = await sendTelegramTextMessage({
          chatId: message.chat.id,
          text: [
            "✅ Подарок успешно оплачен.",
            "Период подарка: " + String(paymentPayload.months) + " мес.",
            "Получатель: @" + (giftedRecipient.tg_nickname ?? giftedRecipient.tg_id),
          ].join("\n"),
        });

        if (!giftPaymentSuccessResult.ok) {
          console.error(
            "Failed to send gift payment success confirmation:",
            giftPaymentSuccessResult.statusCode,
            giftPaymentSuccessResult.error,
          );
        }

        const recipientChatId = Number(paymentPayload.recipientTgId);
        if (Number.isSafeInteger(recipientChatId)) {
          const recipientNotificationResult = await sendTelegramTextMessage({
            chatId: recipientChatId,
            text: [
              "🎁 Вам отправлен подарок.",
              "Период: " + String(paymentPayload.months) + " мес.",
              "От: @" + (message.from.username ?? String(message.from.id)),
              "Откройте раздел Подарки, чтобы активировать.",
            ].join("\n"),
          });

          if (!recipientNotificationResult.ok) {
            console.error(
              "Failed to send gift notification to recipient:",
              recipientNotificationResult.statusCode,
              recipientNotificationResult.error,
            );
          }
        }

        res.status(200).json({
          ok: true,
          processed: true,
          paymentApplied: true,
        });
        return;
      }

      const updatedUser = await finalizeTelegramPaidSubscriptionPurchase({
        tgId: String(message.from.id),
        tgNickname: message.from.username ?? null,
        months: paymentPayload.months,
      });

      if (validatedUsdAmount > 0) {
        try {
          await applyReferralRewardForPurchase({
            payerTgId: String(message.from.id),
            payerTgNickname: message.from.username ?? null,
            purchaseAmountUsd: validatedUsdAmount,
          });
        } catch (rewardError) {
          console.error(
            "Failed to apply referral reward after Telegram Stars payment:",
            rewardError,
          );
        }
      }

      const paymentSuccessResult = await sendTelegramTextMessage({
        chatId: message.chat.id,
        text: [
          "✅ Платеж успешно выполнен звездами.",
          "Оплачено на: " +
            String(paymentPayload.months) +
            " месяц" +
            (paymentPayload.months === 1 ? "" : "ев") +
            ".",
          "🟢 Статус подписки: LIVE",
          updatedUser.subscription_untill
            ? "Действительна до: " + updatedUser.subscription_untill
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

  if (
    message.from !== undefined &&
    message.text !== undefined &&
    hasPendingGiftRecipientInput(String(message.from.id)) &&
    !message.text.trim().startsWith("/")
  ) {
    const rawNicknameInput = message.text.trim();

    if (!/^@[a-zA-Z0-9_]{5,32}$/u.test(rawNicknameInput)) {
      const invalidLoginResult = await sendTelegramTextMessage({
        chatId: message.chat.id,
        text: "Введите корректный логин пользователя в формате @username.",
      });

      if (!invalidLoginResult.ok) {
        console.error(
          "Failed to send invalid gift recipient login message:",
          invalidLoginResult.statusCode,
          invalidLoginResult.error,
        );
      }

      res.status(200).json({
        ok: true,
        processed: true,
        pendingGiftRecipient: true,
        sent: invalidLoginResult.ok,
      });
      return;
    }

    try {
      const recipientUser = await findTelegramUserByNickname(rawNicknameInput);

      if (recipientUser === null) {
        const userNotFoundResult = await sendTelegramTextMessage({
          chatId: message.chat.id,
          text: "Пользователь не найден.",
        });

        if (!userNotFoundResult.ok) {
          console.error(
            "Failed to send gift recipient not found message:",
            userNotFoundResult.statusCode,
            userNotFoundResult.error,
          );
        }

        res.status(200).json({
          ok: true,
          processed: true,
          pendingGiftRecipient: true,
          sent: userNotFoundResult.ok,
        });
        return;
      }

      if (recipientUser.tg_id === String(message.from.id)) {
        const selfGiftBlockedResult = await sendTelegramTextMessage({
          chatId: message.chat.id,
          text: "Нельзя отправить подарок самому себе.",
        });

        if (!selfGiftBlockedResult.ok) {
          console.error(
            "Failed to send self-gift blocked message:",
            selfGiftBlockedResult.statusCode,
            selfGiftBlockedResult.error,
          );
        }

        res.status(200).json({
          ok: true,
          processed: true,
          pendingGiftRecipient: true,
          sent: selfGiftBlockedResult.ok,
        });
        return;
      }

      clearPendingGiftRecipientInput(String(message.from.id));

      const paymentMethodsResult = await sendTelegramInlineMenuMessage({
        chatId: message.chat.id,
        text:
          "Выберите способ оплаты подарка для @" +
          (recipientUser.tg_nickname ?? recipientUser.tg_id) +
          ":",
        inlineKeyboardRows: [
          [
            {
              text: "⭐ Telegram Stars",
              callbackData: "gift:method:tg_stars:" + recipientUser.tg_id,
            },
          ],
          [{ text: "TBD", callbackData: "gift:method:tbd_1:" + recipientUser.tg_id }],
          [{ text: "TBD", callbackData: "gift:method:tbd_2:" + recipientUser.tg_id }],
        ],
      });

      if (!paymentMethodsResult.ok) {
        console.error(
          "Failed to send gift payment methods:",
          paymentMethodsResult.statusCode,
          paymentMethodsResult.error,
        );
      }

      res.status(200).json({
        ok: true,
        processed: true,
        pendingGiftRecipient: false,
        sent: paymentMethodsResult.ok,
      });
      return;
    } catch (error) {
      console.error("Failed to resolve gift recipient from login:", error);
      res.status(200).json({
        ok: true,
        processed: true,
        pendingGiftRecipient: true,
        sent: false,
      });
      return;
    }
  }

  if (
    message.from !== undefined &&
    message.text !== undefined &&
    hasPendingPromoInput(String(message.from.id)) &&
    !message.text.trim().startsWith("/")
  ) {
    try {
      const userTgId = String(message.from.id);
      const telegramUser = await getTelegramUserByTgId(userTgId);

      if (telegramUser === null) {
        clearPendingPromoInput(userTgId);

        const noUserResult = await sendTelegramTextMessage({
          chatId: message.chat.id,
          text: "Профиль не найден. Используйте /start, затем попробуйте снова.",
        });

        if (!noUserResult.ok) {
          console.error(
            "Failed to send missing profile message during promo input:",
            noUserResult.statusCode,
            noUserResult.error,
          );
        }

        res.status(200).json({
          ok: true,
          processed: true,
          pendingPromo: false,
          sent: noUserResult.ok,
        });
        return;
      }

      if (telegramUser.has_purchased) {
        clearPendingPromoInput(userTgId);

        const alreadyPurchasedResult = await sendTelegramTextMessage({
          chatId: message.chat.id,
          text: "Промокод работает только на первую покупку",
        });

        if (!alreadyPurchasedResult.ok) {
          console.error(
            "Failed to send promo first-purchase restriction during input:",
            alreadyPurchasedResult.statusCode,
            alreadyPurchasedResult.error,
          );
        }

        res.status(200).json({
          ok: true,
          processed: true,
          pendingPromo: false,
          sent: alreadyPurchasedResult.ok,
        });
        return;
      }

      const promoCode = message.text.trim();
      const promo = await getBlogerPromoByCode(promoCode);

      if (promo === null) {
        const promoNotFoundResult = await sendTelegramTextMessage({
          chatId: message.chat.id,
          text: "Промокод не найден.",
        });

        if (!promoNotFoundResult.ok) {
          console.error(
            "Failed to send promo not found message:",
            promoNotFoundResult.statusCode,
            promoNotFoundResult.error,
          );
        }

        res.status(200).json({
          ok: true,
          processed: true,
          pendingPromo: true,
          sent: promoNotFoundResult.ok,
        });
        return;
      }

      const updatedUser = await applyPromoToTelegramUser({
        tgId: userTgId,
        promoCode: promo.promocode,
        discountPercent: promo.amountOfDiscount,
        stateForReferredBy: promo.stateForReferredBy,
      });

      clearPendingPromoInput(userTgId);

      const appliedPromoResult = await sendTelegramTextMessage({
        chatId: message.chat.id,
        text: [
          "✅ Промокод активирован.",
          "Промокод: " + promo.promocode,
          "Скидка: " + String(updatedUser.current_discount) + "%",
        ].join("\n"),
      });

      if (!appliedPromoResult.ok) {
        console.error(
          "Failed to send promo applied message:",
          appliedPromoResult.statusCode,
          appliedPromoResult.error,
        );
      }

      res.status(200).json({
        ok: true,
        processed: true,
        pendingPromo: false,
        sent: appliedPromoResult.ok,
      });
      return;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "";
      const firstPurchaseOnly = errorMessage.includes("PROMO_ONLY_FIRST_PURCHASE");

      const promoFailedResult = await sendTelegramTextMessage({
        chatId: message.chat.id,
        text: firstPurchaseOnly
          ? "Промокод работает только на первую покупку"
          : "Не удалось активировать промокод. Попробуйте позже.",
      });

      if (!promoFailedResult.ok) {
        console.error(
          "Failed to send promo activation failure message:",
          promoFailedResult.statusCode,
          promoFailedResult.error,
        );
      }

      if (firstPurchaseOnly) {
        clearPendingPromoInput(String(message.from.id));
      } else {
        console.error("Failed to process promo input:", error);
      }

      res.status(200).json({
        ok: true,
        processed: true,
        pendingPromo: !firstPurchaseOnly,
        sent: promoFailedResult.ok,
      });
      return;
    }
  }

  const parsedCommand = getTelegramCommand(message.text, process.env.BOT_USERNAME);

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
  const startReferralArgument = command === "/start" ? parsedCommand.argument : null;

  if (command !== "/start" && command !== "/menu" && command !== "/clear") {
    res.status(200).json({
      ok: true,
      processed: false,
      reason: "Command is not handled.",
    });
    return;
  }

  if (command === "/clear") {
    if (message.from !== undefined) {
      clearPendingGiftRecipientInput(String(message.from.id));
      clearPendingPromoInput(String(message.from.id));
    }

    try {
      const clearResult = await enqueueClearChatHistory({
        chatId: message.chat.id,
        upToMessageId: message.message_id ?? 1,
      });

      res.status(200).json({
        ok: true,
        processed: true,
        command,
        historyCleared: true,
        attemptedCount: clearResult.attemptedCount,
        deletedCount: clearResult.deletedCount,
        failedCount: clearResult.failedCount,
      });
      return;
    } catch (error) {
      const queueIsOverloaded =
        error instanceof Error && error.message === clearQueueOverloadedErrorCode;

      if (queueIsOverloaded) {
        const queueBusyResult = await sendTelegramTextMessage({
          chatId: message.chat.id,
          text: "Попробуйте очистку позже, слишком много пользователей удаляет сообщения",
        });

        if (!queueBusyResult.ok) {
          console.error(
            "Failed to send clear queue overload message:",
            queueBusyResult.statusCode,
            queueBusyResult.error,
          );
        }

        res.status(200).json({
          ok: true,
          processed: true,
          command,
          historyCleared: false,
          reason: "Clear queue is overloaded.",
        });
        return;
      }

      console.error("Failed to clear Telegram chat history:", error);
      res.status(200).json({
        ok: true,
        processed: true,
        command,
        historyCleared: false,
        reason: "Failed to clear chat history.",
      });
      return;
    }
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
  let referredBy: {
    tgId: string;
    tgNickname: string | null;
    referDate: string;
  } | null = null;

  if (startReferralArgument !== null) {
    const referredByTgId = startReferralArgument.replace(/^ref_/u, "");

    if (referredByTgId !== String(message.from.id)) {
      try {
        const referrerUser = await getTelegramUserByTgId(referredByTgId);

        if (referrerUser !== null) {
          referredBy = {
            tgId: referrerUser.tg_id,
            tgNickname: referrerUser.tg_nickname,
            referDate: new Date().toISOString().slice(0, 10),
          };
        }
      } catch (error) {
        console.error("Failed to resolve referral source from /start payload:", error);
      }
    }
  }

  try {
    userSyncResult = await ensureTelegramUser({
      tgId: String(message.from.id),
      tgNickname: message.from.username ?? null,
      referredBy,
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
        ? "Поздравляем, вы зарегистрированы! Как новому пользователю, вам начислено 3 дня бесплатной подписки."
        : "Добро пожаловать в Starlink."
      : "Главное меню:",
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
