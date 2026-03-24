import type { Request, Response } from "express";
import { z } from "zod";
import {
  answerTelegramCallbackQuery,
  answerTelegramPreCheckoutQuery,
  clearTelegramChatHistoryBySweep,
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
import { checkCryptoBotInvoiceByIdForUser } from "../../../services/cryptoBotPaymentsSyncService";
import {
  cancelRemoteCryptoBotInvoice,
  createCryptoBotSubscriptionInvoice,
  getActiveCryptoBotInvoiceByTgId,
  getCryptoBotInvoiceByInvoiceId,
  updateCryptoBotInvoiceStatus,
} from "../../../services/cryptoBotService";
import {
  banTelegramUserByNickname,
  disableAdminVpsServer,
  disconnectTelegramUserConnectionsByNickname,
  enableAdminVpsServer,
  getAdminUserDetailsByTgId,
  getAdminVpsServerByInternalUuid,
  listAdminUsersPage,
  listAdminVpsServers,
  reloadAdminVpsServer,
  unbanTelegramUserByNickname,
} from "../../../services/telegramAdminService";
import {
  getVpsCountryByInternalUuid,
  getVpsRouteInfoByInternalUuid,
  getVpsProtocolDisplayName,
  issueOrGetUserVpsConfigUrl,
  listUniqueVpsCountries,
  listVpsByCountry,
} from "../../../services/vpsCatalogService";
import {
  getAdminActionFromCallbackData,
  buildGiftInvoicePayload,
  buildSupportInvoicePayload,
  buildVpsButtonText,
  buildSubscriptionInvoicePayload,
  buildSubscriptionStatusTextFromDb,
  getSubscriptionPaymentMethodInlineKeyboardRows,
  getCountriesActionFromCallbackData,
  getFaqActionFromCallbackData,
  getFaqActionText,
  getFaqMenuInlineKeyboardRows,
  getHowToActionFromCallbackData,
  getGiftsActionFromCallbackData,
  getMenuKeyFromCallbackData,
  getPurchaseActionFromCallbackData,
  getReferalsActionFromCallbackData,
  getSettingsActionFromCallbackData,
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
const pendingSupportInputByTgId = new Map<string, number>();
type PendingAdminUserInputAction = "ban" | "unban" | "disconnect_all";
interface PendingAdminUserInputState {
  action: PendingAdminUserInputAction;
  createdAt: number;
}
const pendingAdminUserInputByTgId = new Map<string, PendingAdminUserInputState>();
const pendingGiftRecipientInputTtlMs = 15 * 60 * 1000;
const pendingPromoInputTtlMs = 15 * 60 * 1000;
const pendingSupportInputTtlMs = 15 * 60 * 1000;
const pendingAdminUserInputTtlMs = 15 * 60 * 1000;
const clearQueueMaxPending = 5;
const clearQueueSweepLimit = 5000;
const clearQueueOverloadedErrorCode = "CLEAR_QUEUE_OVERLOADED";
const adminUsersPageSize = 10;
const supportTelegramHandle = process.env.SUPPORT_TG_USERNAME?.trim() || "@starlinkacc";
const trialUnblockAccessHours = 6;
const unblockCountryPattern = /unblock|whitelist|анблок|вайтлист/iu;

interface ClearQueueTask {
  chatId: number;
  upToMessageId: number;
  resolve: (result: Awaited<ReturnType<typeof clearTelegramChatHistoryBySweep>>) => void;
  reject: (error: unknown) => void;
}

const clearQueueTasks: ClearQueueTask[] = [];
let isClearQueueWorkerRunning = false;
const telegramDebugLogsEnabled = process.env.TELEGRAM_DEBUG_LOGS?.trim().toLowerCase() === "true";

function logTelegramDebug(event: string, data?: Record<string, unknown>): void {
  if (!telegramDebugLogsEnabled) {
    return;
  }

  if (data === undefined) {
    console.log("[telegram-debug]", event);
    return;
  }

  console.log("[telegram-debug]", event, JSON.stringify(data));
}

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

function startPendingSupportInput(tgId: string): void {
  pendingSupportInputByTgId.set(tgId, Date.now());
}

function clearPendingSupportInput(tgId: string): void {
  pendingSupportInputByTgId.delete(tgId);
}

function hasPendingSupportInput(tgId: string): boolean {
  const createdAt = pendingSupportInputByTgId.get(tgId);

  if (createdAt === undefined) {
    return false;
  }

  if (Date.now() - createdAt > pendingSupportInputTtlMs) {
    pendingSupportInputByTgId.delete(tgId);
    return false;
  }

  return true;
}

function startPendingAdminUserInput(tgId: string, action: PendingAdminUserInputAction): void {
  pendingAdminUserInputByTgId.set(tgId, {
    action,
    createdAt: Date.now(),
  });
}

function clearPendingAdminUserInput(tgId: string): void {
  pendingAdminUserInputByTgId.delete(tgId);
}

function getPendingAdminUserInputAction(tgId: string): PendingAdminUserInputAction | null {
  const state = pendingAdminUserInputByTgId.get(tgId);

  if (state === undefined) {
    return null;
  }

  if (Date.now() - state.createdAt > pendingAdminUserInputTtlMs) {
    pendingAdminUserInputByTgId.delete(tgId);
    return null;
  }

  return state.action;
}

function getBannedUserMessage(): string {
  return "Вы забанены, обратитесь в поддержку: " + supportTelegramHandle;
}

function isUnblockCountryName(country: string): boolean {
  return unblockCountryPattern.test(country);
}

function isTrialUnblockWindowExpired(input: { createdAt: string; hasPurchased: boolean }): boolean {
  if (input.hasPurchased) {
    return false;
  }

  const createdAtMs = Date.parse(input.createdAt);

  if (!Number.isFinite(createdAtMs)) {
    return true;
  }

  return Date.now() - createdAtMs > trialUnblockAccessHours * 60 * 60 * 1000;
}

function formatSubscriptionStatusLabel(status: "live" | "ending" | null): string {
  if (status === "live") {
    return "LIVE";
  }

  if (status === "ending") {
    return "ENDING";
  }

  return "NOT_FOUND";
}

function buildAdminPanelRootKeyboard() {
  return [
    [{ text: "👥 Пользователи", callbackData: "admin:users" }],
    [{ text: "🖥️ Серверы", callbackData: "admin:servers" }],
  ];
}

function buildAdminUsersMenuKeyboard() {
  return [
    [{ text: "📄 Список пользователей", callbackData: "admin:users:list:1" }],
    [{ text: "⛔ Забанить пользователя", callbackData: "admin:users:prompt:ban" }],
    [{ text: "✅ Разбанить пользователя", callbackData: "admin:users:prompt:unban" }],
    [
      {
        text: "🔌 Отключить пользователю все соединения",
        callbackData: "admin:users:prompt:disconnect_all",
      },
    ],
    [{ text: "⬅️ Назад в админ панель", callbackData: "admin:root" }],
  ];
}

function buildAdminUsersPaginationRows(params: {
  page: number;
  totalPages: number;
}): Array<Array<{ text: string; callbackData: string }>> {
  const rows: Array<Array<{ text: string; callbackData: string }>> = [];

  if (params.totalPages > 1) {
    rows.push([
      {
        text: "⬅️",
        callbackData: "admin:users:list:" + String(Math.max(1, params.page - 1)),
      },
      {
        text: "Стр. " + String(params.page) + "/" + String(params.totalPages),
        callbackData: "admin:users:list:" + String(params.page),
      },
      {
        text: "➡️",
        callbackData: "admin:users:list:" + String(Math.min(params.totalPages, params.page + 1)),
      },
    ]);

    const pageButtons: Array<{ text: string; callbackData: string }> = [];
    const start = Math.max(1, params.page - 2);
    const end = Math.min(params.totalPages, start + 4);

    for (let nextPage = start; nextPage <= end; nextPage += 1) {
      pageButtons.push({
        text: nextPage === params.page ? "• " + String(nextPage) : String(nextPage),
        callbackData: "admin:users:list:" + String(nextPage),
      });
    }

    rows.push(pageButtons);
  }

  rows.push([{ text: "⬅️ Назад к пользователям", callbackData: "admin:users" }]);
  return rows;
}

function formatAdminServerStatus(server: { connection: boolean; disabled: boolean }): string {
  if (server.disabled) {
    return "🔴 OFF";
  }

  if (!server.connection) {
    return "🟠 DOWN";
  }

  return "🟢 UP";
}

function splitTelegramTextIntoChunks(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const remaining = text.length - cursor;
    if (remaining <= maxLength) {
      chunks.push(text.slice(cursor));
      break;
    }

    const nextSlice = text.slice(cursor, cursor + maxLength);
    const lastNewline = nextSlice.lastIndexOf("\n");
    const lastSpace = nextSlice.lastIndexOf(" ");
    let splitIndex = Math.max(lastNewline, lastSpace);

    if (splitIndex < Math.floor(maxLength * 0.6)) {
      splitIndex = maxLength;
    }

    if (splitIndex <= 0) {
      splitIndex = maxLength;
    }

    chunks.push(text.slice(cursor, cursor + splitIndex));
    cursor += splitIndex;
  }

  return chunks;
}

function buildAdminServerDetailsText(server: {
  internalUuid: string;
  nickname: string | null;
  country: string;
  countryEmoji: string;
  apiAddress: string;
  domain: string;
  sshKey: string | null;
  sshConnectionKey: string | null;
  isUnblock: boolean;
  password: string | null;
  optionalPasssword: string | null;
  numberOfConnections: number;
  currentSpeed: number;
  connection: boolean;
  disabled: boolean;
  usersKvCount: number;
  usersKvMapKeys: string[];
  configList: string[];
  createdAt: string;
  updatedAt: string;
}): string {
  return [
    "🖥️ Сервер",
    "internal_uuid: " + server.internalUuid,
    "nickname: " + (server.nickname ?? "—"),
    "country: " + server.country + " " + server.countryEmoji,
    "api_address: " + server.apiAddress,
    "domain: " + server.domain,
    "ssh_key: " + (server.sshKey ?? "—"),
    "ssh_connection_key: " + (server.sshConnectionKey ?? "—"),
    "isUnblock: " + (server.isUnblock ? "true" : "false"),
    "password: " + (server.password ?? "—"),
    "optional_passsword: " + (server.optionalPasssword ?? "null"),
    "number_of_connections: " + String(server.numberOfConnections),
    "current_speed: " + server.currentSpeed.toFixed(2) + " MB/s",
    "connection: " + (server.connection ? "true" : "false"),
    "disabled: " + (server.disabled ? "true" : "false"),
    "users_kv_count: " + String(server.usersKvCount),
    "users_kv_map_keys: " + (server.usersKvMapKeys.join(", ") || "—"),
    "config_list_count: " + String(server.configList.length),
    "config_list: " + (server.configList.join(" | ") || "—"),
    "created_at: " + server.createdAt,
    "updated_at: " + server.updatedAt,
  ].join("\n");
}

function buildHowToPlatformsInlineRows(): Array<Array<{ text: string; callbackData: string }>> {
  return [
    [{ text: "🍎 iOS", callbackData: "howto:ios" }],
    [{ text: "🤖 Android", callbackData: "howto:android" }],
    [{ text: "💻 macOS", callbackData: "howto:macos" }],
    [{ text: "🪟 Windows", callbackData: "howto:windows" }],
    [{ text: "📺 Android TV", callbackData: "howto:android_tv" }],
  ];
}

function buildSettingsProtocolsInlineRows(): Array<Array<{ text: string; callbackData: string }>> {
  return [
    [
      {
        text: "🚨 Вайтлист + анблок (КОГДА ГЛУШАТ)",
        callbackData: "settings:whitelist_unblock",
      },
    ],
    [{ text: "🛰️ Vless Websocket", callbackData: "settings:vless_websocket" }],
    [{ text: "🛡️ Trojan", callbackData: "settings:trojan" }],
    [{ text: "🔐 Trojan obfuscated", callbackData: "settings:trojan_obfuscated" }],
    [{ text: "📶 Shadowsocks (для WiFi)", callbackData: "settings:shadowsocks_wifi" }],
  ];
}

function buildCountriesProtocolSelectionRows(
  internalUuid: string,
): Array<Array<{ text: string; callbackData: string }>> {
  return [
    [{ text: "🛡️ Trojan", callbackData: "c:p:" + internalUuid + ":t" }],
    [
      {
        text: "🔐 Trojan Obfuscated",
        callbackData: "c:p:" + internalUuid + ":to",
      },
    ],
    [
      {
        text: "📶 ShadowSocks (WiFi & LAN)",
        callbackData: "c:p:" + internalUuid + ":s",
      },
    ],
    [{ text: "🛰️ VLESS + WS", callbackData: "c:p:" + internalUuid + ":v" }],
    [
      { text: "🤔 В чем разница?", callbackData: "c:h:d" },
      { text: "📱 Как подключиться", callbackData: "c:h:c" },
    ],
  ];
}

function buildUnblockTrialConfirmRows(
  internalUuid: string,
): Array<Array<{ text: string; callbackData: string }>> {
  return [
    [{ text: "Я уверен", callbackData: "c:uc:" + internalUuid }],
    [{ text: "Назад", callbackData: "menu:countries" }],
  ];
}

async function sendHowToPlatformsMenu(chatId: number) {
  return sendTelegramInlineMenuMessage({
    chatId,
    text: "Выберите устройство:",
    inlineKeyboardRows: buildHowToPlatformsInlineRows(),
  });
}

async function sendSettingsProtocolsMenu(chatId: number) {
  return sendTelegramInlineMenuMessage({
    chatId,
    text: "Наши протоколы:",
    inlineKeyboardRows: buildSettingsProtocolsInlineRows(),
  });
}

async function sendCountryVpsListMenu(params: { chatId: number; country: string }) {
  const vpsList = await listVpsByCountry(params.country);

  return vpsList.length === 0
    ? await sendTelegramTextMessage({
        chatId: params.chatId,
        text: "Для страны " + params.country + " серверы пока не добавлены.",
      })
    : await sendTelegramInlineMenuMessage({
        chatId: params.chatId,
        text: "Серверы в " + params.country + ":",
        inlineKeyboardRows: vpsList.map((vpsItem) => [
          {
            text: buildVpsButtonText({
              nickname: vpsItem.nickname,
              internalUuid: vpsItem.internalUuid,
              countryEmoji: vpsItem.countryEmoji,
              isUnblock: vpsItem.isUnblock,
              currentSpeed: vpsItem.currentSpeed,
              numberOfConnections: vpsItem.numberOfConnections,
            }),
            callbackData: "c:v:" + vpsItem.internalUuid,
          },
        ]),
      });
}

async function sendUnblockVpsConfigMessage(input: {
  chatId: number;
  internalUuid: string;
  userInternalUuid: string;
}): Promise<boolean> {
  const vpsConfig = await issueOrGetUserVpsConfigUrl(
    input.internalUuid,
    input.userInternalUuid,
    "vless_ws",
  );
  let sent = true;

  if (vpsConfig === null) {
    const notFoundResult = await sendTelegramTextMessage({
      chatId: input.chatId,
      text: "Конфигурация сервера не найдена.",
    });

    if (!notFoundResult.ok) {
      console.error(
        "Failed to send missing unblock VPS config message:",
        notFoundResult.statusCode,
        notFoundResult.error,
      );
      sent = false;
    }

    return sent;
  }

  const introResult = await sendTelegramTextMessage({
    chatId: input.chatId,
    text: "Ваша персональная ссылка (VLESS + WS):",
    protectContent: true,
  });

  if (!introResult.ok) {
    console.error(
      "Failed to send unblock config intro message:",
      introResult.statusCode,
      introResult.error,
    );
    sent = false;
  }

  const escapedConfigUrl = vpsConfig.url
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const configMessageResult = await sendTelegramTextMessage({
    chatId: input.chatId,
    text: "<code>" + escapedConfigUrl + "</code>",
    protectContent: true,
    parseMode: "HTML",
  });

  if (!configMessageResult.ok) {
    console.error(
      "Failed to send unblock protected VPS config URL:",
      configMessageResult.statusCode,
      configMessageResult.error,
    );
    sent = false;
  }

  return sent;
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

function formatUsdAmount(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return rounded
    .toFixed(2)
    .replace(/\.00$/u, "")
    .replace(/(\.\d)0$/u, "$1");
}

function buildCryptoBotActiveInvoiceKeyboard(invoiceId: number, botInvoiceUrl: string) {
  return [
    [{ text: "💳 Перейти к CryptoBot", url: botInvoiceUrl }],
    [{ text: "✅ Проверить оплату", callbackData: "buy:crypto_check:" + String(invoiceId) }],
    [{ text: "❌ Отменить", callbackData: "buy:crypto_cancel:" + String(invoiceId) }],
  ];
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
    logTelegramDebug("invalid_update_payload", {
      issues: parsedUpdate.error.issues
        .slice(0, 5)
        .map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
    res.status(200).json({
      ok: true,
      processed: false,
      reason: "Invalid Telegram update payload.",
    });
    return;
  }

  const preCheckoutQuery = parsedUpdate.data.pre_checkout_query;

  if (preCheckoutQuery !== undefined) {
    logTelegramDebug("pre_checkout_received", {
      fromId: preCheckoutQuery.from.id,
      currency: preCheckoutQuery.currency,
      totalAmount: preCheckoutQuery.total_amount,
    });
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
          } else if (invoicePayload.action === "support") {
            isValidPayload = preCheckoutQuery.total_amount === invoicePayload.amount;
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
    const settingsAction = getSettingsActionFromCallbackData(callbackQuery.data);
    const adminAction = getAdminActionFromCallbackData(callbackQuery.data);
    const giftsAction = getGiftsActionFromCallbackData(callbackQuery.data);
    const countriesAction = getCountriesActionFromCallbackData(callbackQuery.data);
    const howToAction = getHowToActionFromCallbackData(callbackQuery.data);
    const callbackChatId = callbackQuery.message?.chat.id;
    const callbackMessageId = callbackQuery.message?.message_id;
    const callbackChatType = callbackQuery.message?.chat.type;
    logTelegramDebug("callback_received", {
      callbackId: callbackQuery.id,
      fromId: callbackQuery.from.id,
      chatId: callbackChatId ?? null,
      messageId: callbackMessageId ?? null,
      data: callbackQuery.data ?? null,
      menuKey: menuKey ?? null,
      purchaseKind: purchaseAction?.kind ?? null,
    });

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
            : purchaseAction.kind === "crypto_check"
              ? "Checking payment..."
              : purchaseAction.kind === "crypto_cancel"
                ? "Opening cancel confirmation..."
                : purchaseAction.kind === "crypto_cancel_confirm"
                  ? "Cancelling invoice..."
                  : purchaseAction.kind === "crypto_cancel_abort"
                    ? "Continuing payment..."
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
                : settingsAction !== null
                  ? "Opening protocol..."
                  : adminAction !== null
                    ? adminAction.kind === "users_list"
                      ? "Loading users..."
                      : adminAction.kind === "users_detail"
                        ? "Loading user..."
                        : adminAction.kind === "servers"
                          ? "Loading servers..."
                          : adminAction.kind === "servers_detail"
                            ? "Loading server..."
                            : adminAction.kind === "servers_action"
                              ? "Processing server action..."
                              : "Opening admin..."
                    : countriesAction !== null
                      ? countriesAction.kind === "country"
                        ? "Loading VPS list..."
                        : countriesAction.kind === "country_ref"
                          ? "Loading VPS list..."
                          : countriesAction.kind === "unblock_confirm"
                            ? "Loading VPS list..."
                            : countriesAction.kind === "vps"
                              ? "Processing server..."
                              : countriesAction.kind === "vps_protocol"
                                ? "Generating config..."
                                : countriesAction.kind === "help_diff"
                                  ? "Opening protocol details..."
                                  : "Opening guide..."
                      : howToAction !== null
                        ? "Opening guide..."
                        : menuKey === "support"
                          ? "Preparing donation..."
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
      settingsAction === null &&
      adminAction === null &&
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

    const callbackTelegramUser = await getTelegramUserByTgId(String(callbackQuery.from.id));

    if (callbackTelegramUser !== null && callbackTelegramUser.isBanned) {
      const bannedResult = await sendTelegramTextMessage({
        chatId: callbackChatId,
        text: getBannedUserMessage(),
      });

      if (!bannedResult.ok) {
        console.error(
          "Failed to send banned user message on callback:",
          bannedResult.statusCode,
          bannedResult.error,
        );
      }

      res.status(200).json({
        ok: true,
        processed: true,
        callbackHandled: true,
        sent: bannedResult.ok,
      });
      return;
    }

    if (menuKey === "admin_panel" || adminAction !== null) {
      if (callbackTelegramUser === null || !callbackTelegramUser.isAdmin) {
        const deniedResult = await sendTelegramTextMessage({
          chatId: callbackChatId,
          text: "Нет доступа к админ панели.",
        });

        if (!deniedResult.ok) {
          console.error(
            "Failed to send admin panel access denied message:",
            deniedResult.statusCode,
            deniedResult.error,
          );
        }

        res.status(200).json({
          ok: true,
          processed: true,
          callbackHandled: true,
          sent: deniedResult.ok,
        });
        return;
      }

      try {
        if (menuKey === "admin_panel" || adminAction?.kind === "root") {
          const adminRootResult = await sendTelegramInlineMenuMessage({
            chatId: callbackChatId,
            text: "Админ панель:",
            inlineKeyboardRows: buildAdminPanelRootKeyboard(),
          });

          if (!adminRootResult.ok) {
            console.error(
              "Failed to send admin panel root menu:",
              adminRootResult.statusCode,
              adminRootResult.error,
            );
          }

          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent: adminRootResult.ok,
          });
          return;
        }

        if (adminAction?.kind === "users") {
          const usersMenuResult = await sendTelegramInlineMenuMessage({
            chatId: callbackChatId,
            text: "Управление пользователями:",
            inlineKeyboardRows: buildAdminUsersMenuKeyboard(),
          });

          if (!usersMenuResult.ok) {
            console.error(
              "Failed to send admin users menu:",
              usersMenuResult.statusCode,
              usersMenuResult.error,
            );
          }

          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent: usersMenuResult.ok,
          });
          return;
        }

        if (adminAction?.kind === "users_prompt") {
          const actionTextMap: Record<PendingAdminUserInputAction, string> = {
            ban: "Введите логин пользователя в Telegram вместе с @ для бана:",
            unban: "Введите логин пользователя в Telegram вместе с @ для разбана:",
            disconnect_all:
              "Введите логин пользователя в Telegram вместе с @, чтобы отключить все его соединения:",
          };

          startPendingAdminUserInput(String(callbackQuery.from.id), adminAction.action);
          const promptResult = await sendTelegramTextMessage({
            chatId: callbackChatId,
            text: actionTextMap[adminAction.action],
          });

          if (!promptResult.ok) {
            console.error(
              "Failed to send admin users prompt message:",
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

        if (adminAction?.kind === "users_list") {
          const usersPage = await listAdminUsersPage(adminAction.page, adminUsersPageSize);
          const userRows = usersPage.users.map((user) => [
            {
              text:
                (user.isBanned ? "⛔ " : "") +
                "@" +
                (user.tgNickname ?? user.tgId) +
                " • " +
                user.tgId,
              callbackData: "admin:users:detail:" + user.tgId,
            },
          ]);
          const paginationRows = buildAdminUsersPaginationRows({
            page: usersPage.page,
            totalPages: usersPage.totalPages,
          });
          const usersListResult = await sendTelegramInlineMenuMessage({
            chatId: callbackChatId,
            text:
              "Пользователи: " +
              String(usersPage.totalCount) +
              "\nСтраница: " +
              String(usersPage.page) +
              "/" +
              String(usersPage.totalPages),
            inlineKeyboardRows:
              usersPage.users.length === 0
                ? [
                    [{ text: "Пользователей пока нет", callbackData: "admin:users:list:1" }],
                    [{ text: "⬅️ Назад к пользователям", callbackData: "admin:users" }],
                  ]
                : [...userRows, ...paginationRows],
          });

          if (!usersListResult.ok) {
            console.error(
              "Failed to send admin users paginated list:",
              usersListResult.statusCode,
              usersListResult.error,
            );
          }

          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent: usersListResult.ok,
          });
          return;
        }

        if (adminAction?.kind === "users_detail") {
          const details = await getAdminUserDetailsByTgId(adminAction.tgId);
          const userDetailsText =
            details === null
              ? "Пользователь не найден."
              : [
                  "👤 Пользователь",
                  "Ник в тг: @" + (details.tgNickname ?? "—"),
                  "ТГ айди: " + details.tgId,
                  "Всего траффика: " + String(details.trafficConsumedMb) + " MB",
                  "Статус подписки: " + formatSubscriptionStatusLabel(details.subscriptionStatus),
                  "Подписка до: " + (details.subscriptionUntill ?? "—"),
                  "Дата создания: " + details.createdAt,
                  "Заработано с рефералки: $" + details.earnedMoney.toFixed(2),
                  "Подарки: " + String(details.giftsCount),
                  "Скидка: " + String(details.currentDiscount) + "%",
                  "Покупал подписку: " + (details.hasPurchased ? "Да" : "Нет"),
                  "Забанен: " + (details.isBanned ? "Да" : "Нет"),
                  "Подключен к: " + (details.connectedToServers.join(", ") || "—"),
                  "Всего подключений сейчас: " + String(details.numberOfConnections),
                  details.connectionsByServer.length === 0
                    ? "Карта подключений по серверам: —"
                    : "Карта подключений по серверам: " +
                      details.connectionsByServer
                        .map((entry) => entry.label + " = " + String(entry.activeConnections))
                        .join("; "),
                ].join("\n");

          const userDetailsResult = await sendTelegramInlineMenuMessage({
            chatId: callbackChatId,
            text: userDetailsText,
            inlineKeyboardRows: [
              [{ text: "⬅️ Назад к пользователям", callbackData: "admin:users" }],
            ],
          });

          if (!userDetailsResult.ok) {
            console.error(
              "Failed to send admin user details:",
              userDetailsResult.statusCode,
              userDetailsResult.error,
            );
          }

          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent: userDetailsResult.ok,
          });
          return;
        }

        if (adminAction?.kind === "servers") {
          const servers = await listAdminVpsServers();
          const serversResult = await sendTelegramInlineMenuMessage({
            chatId: callbackChatId,
            text: "Серверы: " + String(servers.length),
            inlineKeyboardRows:
              servers.length === 0
                ? [[{ text: "Серверов пока нет", callbackData: "admin:servers" }]]
                : [
                    ...servers.map((server) => [
                      {
                        text:
                          formatAdminServerStatus(server) +
                          " " +
                          (server.nickname ??
                            "VPS " + server.internalUuid.slice(0, 8).toUpperCase()) +
                          " (" +
                          server.countryEmoji +
                          " " +
                          server.country +
                          ")",
                        callbackData: "admin:servers:detail:" + server.internalUuid,
                      },
                    ]),
                    [{ text: "⬅️ Назад в админ панель", callbackData: "admin:root" }],
                  ],
          });

          if (!serversResult.ok) {
            console.error(
              "Failed to send admin servers list:",
              serversResult.statusCode,
              serversResult.error,
            );
          }

          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent: serversResult.ok,
          });
          return;
        }

        if (adminAction?.kind === "servers_detail") {
          const server = await getAdminVpsServerByInternalUuid(adminAction.internalUuid);
          const serverText =
            server === null ? "Сервер не найден." : buildAdminServerDetailsText(server);

          const serverActionsRows =
            server === null
              ? [[{ text: "⬅️ Назад к серверам", callbackData: "admin:servers" }]]
              : [
                  ...(server.disabled || !server.connection
                    ? [
                        [
                          {
                            text: "✅ Включить сервер",
                            callbackData: "admin:servers:act:enable:" + server.internalUuid,
                          },
                        ],
                      ]
                    : []),
                  [
                    {
                      text: "🔄 Перезагрузить",
                      callbackData: "admin:servers:act:reload:" + server.internalUuid,
                    },
                  ],
                  [
                    {
                      text: "⛔ Отключить сервер",
                      callbackData: "admin:servers:act:disable:" + server.internalUuid,
                    },
                  ],
                  [{ text: "⬅️ Назад к серверам", callbackData: "admin:servers" }],
                ];

          const serverTextChunks =
            server === null ? [serverText] : splitTelegramTextIntoChunks(serverText, 3900);
          const serverDetailsResult = await sendTelegramInlineMenuMessage({
            chatId: callbackChatId,
            text: serverTextChunks[0] ?? serverText,
            inlineKeyboardRows: serverActionsRows,
          });
          let serverDetailsSent = serverDetailsResult.ok;

          if (!serverDetailsResult.ok) {
            console.error(
              "Failed to send admin server details:",
              serverDetailsResult.statusCode,
              serverDetailsResult.error,
            );
          } else if (serverTextChunks.length > 1) {
            for (let chunkIndex = 1; chunkIndex < serverTextChunks.length; chunkIndex += 1) {
              const continuationResult = await sendTelegramTextMessage({
                chatId: callbackChatId,
                text: serverTextChunks[chunkIndex] ?? "",
              });

              if (!continuationResult.ok) {
                serverDetailsSent = false;
                console.error(
                  "Failed to send admin server details chunk:",
                  "index=" + String(chunkIndex),
                  continuationResult.statusCode,
                  continuationResult.error,
                );
              }
            }
          }

          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent: serverDetailsSent,
          });
          return;
        }

        if (adminAction?.kind === "servers_action") {
          const refreshedServer =
            adminAction.action === "enable"
              ? await enableAdminVpsServer(adminAction.internalUuid)
              : adminAction.action === "reload"
                ? await reloadAdminVpsServer(adminAction.internalUuid)
                : await disableAdminVpsServer(adminAction.internalUuid);

          const actionTitle =
            adminAction.action === "enable"
              ? "Сервер включен"
              : adminAction.action === "reload"
                ? "Сервер перезагружен"
                : "Сервер отключен";

          const serverActionResult = await sendTelegramTextMessage({
            chatId: callbackChatId,
            text:
              "✅ " +
              actionTitle +
              "\nСервер: " +
              (refreshedServer.nickname ?? refreshedServer.internalUuid) +
              "\nСтатус: " +
              formatAdminServerStatus(refreshedServer),
          });

          if (!serverActionResult.ok) {
            console.error(
              "Failed to send admin server action result:",
              serverActionResult.statusCode,
              serverActionResult.error,
            );
          }

          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent: serverActionResult.ok,
          });
          return;
        }
      } catch (error) {
        console.error("Admin panel action failed:", error);
        const failedResult = await sendTelegramTextMessage({
          chatId: callbackChatId,
          text: "Не удалось выполнить действие админ панели. Проверьте логи.",
        });

        if (!failedResult.ok) {
          console.error(
            "Failed to send admin action failure message:",
            failedResult.statusCode,
            failedResult.error,
          );
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

    if (purchaseAction !== null) {
      if (purchaseAction.kind === "open") {
        const paymentOptionsResult = await sendTelegramInlineMenuMessage({
          chatId: callbackChatId,
          text: "Choose payment method:",
          inlineKeyboardRows: getSubscriptionPaymentMethodInlineKeyboardRows(),
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
        if (purchaseAction.method === "tg_stars" || purchaseAction.method === "crypto_bot") {
          let planOptionsResult: Awaited<ReturnType<typeof sendTelegramInlineMenuMessage>>;

          try {
            if (purchaseAction.method === "crypto_bot") {
              const activeInvoice = await getActiveCryptoBotInvoiceByTgId(
                String(callbackQuery.from.id),
              );

              if (activeInvoice !== null) {
                logTelegramDebug("crypto_active_invoice_blocked_from_method", {
                  tgId: String(callbackQuery.from.id),
                  invoiceId: activeInvoice.invoiceId,
                });
                planOptionsResult = await sendTelegramInlineMenuMessage({
                  chatId: callbackChatId,
                  text: "У вас есть активный иновойс в CryptoBot. Оплатите или отмените его:",
                  inlineKeyboardRows: buildCryptoBotActiveInvoiceKeyboard(
                    activeInvoice.invoiceId,
                    activeInvoice.botInvoiceUrl,
                  ),
                });

                if (!planOptionsResult.ok) {
                  console.error(
                    "Failed to send active CryptoBot invoice from method screen:",
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
            }

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
              const isStarsMethod = purchaseAction.method === "tg_stars";
              planOptionsResult = await sendTelegramInlineMenuMessage({
                chatId: callbackChatId,
                text: isStarsMethod
                  ? discountPercent > 0
                    ? "Choose Telegram Stars plan (скидка " + String(discountPercent) + "%):"
                    : "Choose Telegram Stars plan:"
                  : discountPercent > 0
                    ? "Choose CryptoBot plan (скидка " + String(discountPercent) + "%):"
                    : "Choose CryptoBot plan (any crypto asset):",
                inlineKeyboardRows: prices.map((price) => [
                  {
                    text: isStarsMethod
                      ? String(price.months) +
                        " " +
                        (price.months === 1 ? "month" : "months") +
                        " • " +
                        String(applyPercentDiscountToStars(price.stars, discountPercent)) +
                        " ⭐" +
                        (discountPercent > 0 ? " (-" + String(discountPercent) + "%)" : "")
                      : String(price.months) +
                        " " +
                        (price.months === 1 ? "month" : "months") +
                        " • $" +
                        formatUsdAmount(applyPercentDiscountToUsd(price.usdt, discountPercent)) +
                        (discountPercent > 0 ? " (-" + String(discountPercent) + "%)" : ""),
                    callbackData: "buy:plan:" + purchaseAction.method + ":" + String(price.months),
                  },
                ]),
              });
            }
          } catch (error) {
            console.error("Failed to fetch plan options from DB:", error);
            planOptionsResult = await sendTelegramTextMessage({
              chatId: callbackChatId,
              text: "Не удалось загрузить тарифы. Попробуйте позже.",
            });
          }

          if (!planOptionsResult.ok) {
            console.error(
              "Failed to send plan options:",
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

      if (purchaseAction.kind === "crypto_check") {
        logTelegramDebug("crypto_check_start", {
          tgId: String(callbackQuery.from.id),
          invoiceId: purchaseAction.invoiceId,
        });
        let checkStatus: Awaited<ReturnType<typeof checkCryptoBotInvoiceByIdForUser>>;

        try {
          checkStatus = await checkCryptoBotInvoiceByIdForUser({
            tgId: String(callbackQuery.from.id),
            invoiceId: purchaseAction.invoiceId,
          });
        } catch (error) {
          console.error("Failed to check CryptoBot invoice status:", error);
          const checkFailedResult = await sendTelegramTextMessage({
            chatId: callbackChatId,
            text: "Не удалось проверить оплату. Попробуйте чуть позже.",
          });

          if (!checkFailedResult.ok) {
            console.error(
              "Failed to send CryptoBot check failure message:",
              checkFailedResult.statusCode,
              checkFailedResult.error,
            );
          }

          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent: checkFailedResult.ok,
          });
          return;
        }

        const statusText =
          checkStatus === "paid"
            ? "✅ Оплата подтверждена, подписка активирована."
            : checkStatus === "already_paid"
              ? "✅ Этот счет уже оплачен ранее."
              : checkStatus === "pending"
                ? "⌛ Оплата пока не подтверждена. Нажмите Проверить оплату через 10-20 секунд."
                : checkStatus === "expired"
                  ? "⛔ Счет истек. Сформируйте новый платеж."
                  : checkStatus === "cancelled"
                    ? "⛔ Счет отменен. Сформируйте новый платеж."
                    : checkStatus === "forbidden"
                      ? "⛔ Этот счет принадлежит другому пользователю."
                      : checkStatus === "not_found"
                        ? "Счет не найден."
                        : "Ошибка обработки счета. Обратитесь в поддержку.";
        logTelegramDebug("crypto_check_result", {
          tgId: String(callbackQuery.from.id),
          invoiceId: purchaseAction.invoiceId,
          status: checkStatus,
        });

        const checkResult = await sendTelegramTextMessage({
          chatId: callbackChatId,
          text: statusText,
        });

        if (!checkResult.ok) {
          console.error(
            "Failed to send CryptoBot check result message:",
            checkResult.statusCode,
            checkResult.error,
          );
        }

        res.status(200).json({
          ok: true,
          processed: true,
          callbackHandled: true,
          sent: checkResult.ok,
        });
        return;
      }

      if (purchaseAction.kind === "crypto_cancel") {
        logTelegramDebug("crypto_cancel_prompt", {
          tgId: String(callbackQuery.from.id),
          invoiceId: purchaseAction.invoiceId,
        });
        const cancelConfirmResult = await sendTelegramInlineMenuMessage({
          chatId: callbackChatId,
          text: "Вы уверены, что хотите отменить платеж?",
          inlineKeyboardRows: [
            [
              {
                text: "✅ Да, отменить",
                callbackData: "buy:crypto_cancel_confirm:" + String(purchaseAction.invoiceId),
              },
              {
                text: "↩️ Нет, продолжить платеж",
                callbackData: "buy:crypto_cancel_abort:" + String(purchaseAction.invoiceId),
              },
            ],
          ],
        });

        if (!cancelConfirmResult.ok) {
          console.error(
            "Failed to send CryptoBot cancel confirmation message:",
            cancelConfirmResult.statusCode,
            cancelConfirmResult.error,
          );
        }

        res.status(200).json({
          ok: true,
          processed: true,
          callbackHandled: true,
          sent: cancelConfirmResult.ok,
        });
        return;
      }

      if (purchaseAction.kind === "crypto_cancel_abort") {
        logTelegramDebug("crypto_cancel_abort", {
          tgId: String(callbackQuery.from.id),
          invoiceId: purchaseAction.invoiceId,
        });
        const invoice = await getCryptoBotInvoiceByInvoiceId(purchaseAction.invoiceId);

        if (invoice === null || invoice.tgId !== String(callbackQuery.from.id)) {
          const notFoundResult = await sendTelegramTextMessage({
            chatId: callbackChatId,
            text: "Счет не найден.",
          });

          if (!notFoundResult.ok) {
            console.error(
              "Failed to send CryptoBot invoice not found message:",
              notFoundResult.statusCode,
              notFoundResult.error,
            );
          }

          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent: notFoundResult.ok,
          });
          return;
        }

        const continueResult = await sendTelegramInlineMenuMessage({
          chatId: callbackChatId,
          text: "Платеж не отменен. Продолжайте оплату:",
          inlineKeyboardRows: buildCryptoBotActiveInvoiceKeyboard(
            invoice.invoiceId,
            invoice.botInvoiceUrl,
          ),
        });

        if (!continueResult.ok) {
          console.error(
            "Failed to send CryptoBot continue payment message:",
            continueResult.statusCode,
            continueResult.error,
          );
        }

        res.status(200).json({
          ok: true,
          processed: true,
          callbackHandled: true,
          sent: continueResult.ok,
        });
        return;
      }

      if (purchaseAction.kind === "crypto_cancel_confirm") {
        logTelegramDebug("crypto_cancel_confirm", {
          tgId: String(callbackQuery.from.id),
          invoiceId: purchaseAction.invoiceId,
        });
        const invoice = await getCryptoBotInvoiceByInvoiceId(purchaseAction.invoiceId);

        if (invoice === null) {
          const notFoundResult = await sendTelegramTextMessage({
            chatId: callbackChatId,
            text: "Счет не найден.",
          });

          if (!notFoundResult.ok) {
            console.error(
              "Failed to send missing CryptoBot invoice message:",
              notFoundResult.statusCode,
              notFoundResult.error,
            );
          }

          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent: notFoundResult.ok,
          });
          return;
        }

        if (invoice.tgId !== String(callbackQuery.from.id)) {
          const forbiddenResult = await sendTelegramTextMessage({
            chatId: callbackChatId,
            text: "⛔ Этот счет принадлежит другому пользователю.",
          });

          if (!forbiddenResult.ok) {
            console.error(
              "Failed to send forbidden CryptoBot invoice message:",
              forbiddenResult.statusCode,
              forbiddenResult.error,
            );
          }

          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent: forbiddenResult.ok,
          });
          return;
        }

        if (invoice.status !== "active") {
          const inactiveResult = await sendTelegramTextMessage({
            chatId: callbackChatId,
            text:
              invoice.status === "paid"
                ? "✅ Этот счет уже оплачен."
                : invoice.status === "cancelled"
                  ? "⛔ Этот счет уже отменен."
                  : "Счет уже неактивен.",
          });

          if (!inactiveResult.ok) {
            console.error(
              "Failed to send inactive CryptoBot invoice message:",
              inactiveResult.statusCode,
              inactiveResult.error,
            );
          }

          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent: inactiveResult.ok,
          });
          return;
        }

        try {
          const cancelResultPayload = await cancelRemoteCryptoBotInvoice(invoice.invoiceId);
          await updateCryptoBotInvoiceStatus({
            internalUuid: invoice.internalUuid,
            status: "cancelled",
            rawPayload: cancelResultPayload,
            lastError: null,
          });
          logTelegramDebug("crypto_cancelled", {
            tgId: String(callbackQuery.from.id),
            invoiceId: invoice.invoiceId,
          });

          const cancelledResult = await sendTelegramTextMessage({
            chatId: callbackChatId,
            text: "✅ Платеж отменен.",
          });

          if (!cancelledResult.ok) {
            console.error(
              "Failed to send CryptoBot cancelled message:",
              cancelledResult.statusCode,
              cancelledResult.error,
            );
          }

          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent: cancelledResult.ok,
          });
          return;
        } catch (error) {
          console.error("Failed to cancel CryptoBot invoice:", error);
          const cancelFailedResult = await sendTelegramTextMessage({
            chatId: callbackChatId,
            text: "Не удалось отменить счет. Попробуйте позже.",
          });

          if (!cancelFailedResult.ok) {
            console.error(
              "Failed to send CryptoBot cancel failure message:",
              cancelFailedResult.statusCode,
              cancelFailedResult.error,
            );
          }

          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent: cancelFailedResult.ok,
          });
          return;
        }
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

      if (purchaseAction.method === "tg_stars") {
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

      if (purchaseAction.method === "crypto_bot") {
        try {
          const activeInvoice = await getActiveCryptoBotInvoiceByTgId(
            String(callbackQuery.from.id),
          );

          if (activeInvoice !== null) {
            logTelegramDebug("crypto_active_invoice_blocked_from_plan", {
              tgId: String(callbackQuery.from.id),
              invoiceId: activeInvoice.invoiceId,
            });
            const activeInvoiceResult = await sendTelegramInlineMenuMessage({
              chatId: callbackChatId,
              text: "У вас есть активный иновойс в CryptoBot. Оплатите или отмените его:",
              inlineKeyboardRows: buildCryptoBotActiveInvoiceKeyboard(
                activeInvoice.invoiceId,
                activeInvoice.botInvoiceUrl,
              ),
            });

            if (!activeInvoiceResult.ok) {
              console.error(
                "Failed to send active CryptoBot invoice notice:",
                activeInvoiceResult.statusCode,
                activeInvoiceResult.error,
              );
            }

            res.status(200).json({
              ok: true,
              processed: true,
              callbackHandled: true,
              invoiceSent: activeInvoiceResult.ok,
            });
            return;
          }

          const cryptoInvoice = await createCryptoBotSubscriptionInvoice({
            tgId: String(callbackQuery.from.id),
            months: purchaseAction.months,
            amountUsd: selectedPurchaseAmount.usdAmount,
          });
          logTelegramDebug("crypto_invoice_created", {
            tgId: String(callbackQuery.from.id),
            invoiceId: cryptoInvoice.invoiceId,
            months: purchaseAction.months,
            amountUsd: selectedPurchaseAmount.usdAmount,
          });

          const cryptoInvoiceResult = await sendTelegramInlineMenuMessage({
            chatId: callbackChatId,
            text: [
              "💎 Счет CryptoBot создан.",
              "План: " + String(purchaseAction.months) + " мес.",
              "Сумма: $" + formatUsdAmount(selectedPurchaseAmount.usdAmount),
              "Поддерживаются любые доступные криптовалюты в CryptoBot.",
              "После оплаты нажмите кнопку проверки.",
            ].join("\n"),
            inlineKeyboardRows: buildCryptoBotActiveInvoiceKeyboard(
              cryptoInvoice.invoiceId,
              cryptoInvoice.botInvoiceUrl,
            ),
          });

          if (!cryptoInvoiceResult.ok) {
            console.error(
              "Failed to send CryptoBot invoice message:",
              cryptoInvoiceResult.statusCode,
              cryptoInvoiceResult.error,
            );
          }

          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            invoiceSent: cryptoInvoiceResult.ok,
          });
          return;
        } catch (error) {
          console.error("Failed to create CryptoBot invoice:", error);
          const failedResult = await sendTelegramTextMessage({
            chatId: callbackChatId,
            text: "Не удалось создать счет CryptoBot. Попробуйте позже.",
          });

          if (!failedResult.ok) {
            console.error(
              "Failed to send CryptoBot invoice failure message:",
              failedResult.statusCode,
              failedResult.error,
            );
          }

          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            invoiceSent: failedResult.ok,
          });
          return;
        }
      }

      const unsupportedMethodResult = await sendTelegramTextMessage({
        chatId: callbackChatId,
        text: "This payment method is not implemented yet.",
      });

      if (!unsupportedMethodResult.ok) {
        console.error(
          "Failed to send unsupported payment method message:",
          unsupportedMethodResult.statusCode,
          unsupportedMethodResult.error,
        );
      }

      res.status(200).json({
        ok: true,
        processed: true,
        callbackHandled: true,
        invoiceSent: unsupportedMethodResult.ok,
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
      const howToMenuResult = await sendHowToPlatformsMenu(callbackChatId);

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

    if (menuKey === "settings") {
      const settingsProtocolsResult = await sendSettingsProtocolsMenu(callbackChatId);

      if (!settingsProtocolsResult.ok) {
        console.error(
          "Failed to send settings protocols menu:",
          settingsProtocolsResult.statusCode,
          settingsProtocolsResult.error,
        );
      }

      res.status(200).json({
        ok: true,
        processed: true,
        callbackHandled: true,
        sent: settingsProtocolsResult.ok,
      });
      return;
    }

    if (menuKey === "support") {
      startPendingSupportInput(String(callbackQuery.from.id));
      clearPendingGiftRecipientInput(String(callbackQuery.from.id));
      clearPendingPromoInput(String(callbackQuery.from.id));

      const supportPromptResult = await sendTelegramTextMessage({
        chatId: callbackChatId,
        text: "Вы можете поддержать нас с помощью телеграм старс! Так мы сможем бороться с цензурой более эффективно, введите сумму в Telegram Stars которую хотели бы пожертвовать:",
      });

      if (!supportPromptResult.ok) {
        console.error(
          "Failed to send support donation prompt message:",
          supportPromptResult.statusCode,
          supportPromptResult.error,
        );
      }

      res.status(200).json({
        ok: true,
        processed: true,
        callbackHandled: true,
        sent: supportPromptResult.ok,
      });
      return;
    }

    if (settingsAction !== null) {
      const protocolTextByAction: Record<typeof settingsAction.kind, string> = {
        whitelist_unblock:
          "🚨 Вайтлист + анблок (когда глушат)\n\n" +
          "Не работает интернет в центре Москвы или в регионе? Открывается только часть сайтов вроде Яндекса и Госуслуг?\n\n" +
          "Этот режим создан специально для обхода белых списков и большей части сетевых ограничений. Он помогает восстановить доступ к обычному интернету там, где другие протоколы режутся.\n\n" +
          "Подходит для всех устройств.",
        vless_websocket:
          "🛰️ Vless Websocket\n\n" +
          "VLESS через WebSocket маскирует VPN-трафик под обычный HTTPS и лучше проходит через DPI-фильтры.\n\n" +
          "Обычный VLESS без WebSocket обычно менее устойчив в сетях с глубокой фильтрацией и может быть проще для трекинга.\n\n" +
          "Подходит для всех устройств.",
        trojan:
          "🛡️ Trojan\n\n" +
          "Trojan использует TLS и выглядит как стандартный зашифрованный трафик, поэтому сохраняет хорошую стабильность и приватность.\n\n" +
          "Это универсальный протокол для повседневного использования.\n\n" +
          "Подходит для всех устройств.",
        trojan_obfuscated:
          "🔐 Trojan obfuscated\n\n" +
          "Это Trojan с дополнительной обфускацией: трафик сложнее отличить от обычного веб-трафика.\n\n" +
          "Полезен в сетях с агрессивной фильтрацией, когда стандартные варианты работают нестабильно.\n\n" +
          "Подходит для всех устройств.",
        shadowsocks_wifi:
          "📶 Shadowsocks (для WiFi / LAN)\n\n" +
          "Стабильный и быстрый режим для домашних и офисных сетей. Хорошо подходит для соединений по WiFi и кабелю.\n\n" +
          "Важно: этот вариант не рассчитан на мобильную сеть оператора и обычно работает только через WiFi/LAN.",
      };

      const settingsInfoResult = await sendTelegramTextMessage({
        chatId: callbackChatId,
        text: protocolTextByAction[settingsAction.kind],
      });

      if (!settingsInfoResult.ok) {
        console.error(
          "Failed to send settings protocol info message:",
          settingsInfoResult.statusCode,
          settingsInfoResult.error,
        );
      }

      res.status(200).json({
        ok: true,
        processed: true,
        callbackHandled: true,
        sent: settingsInfoResult.ok,
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
                    callbackData: "c:c:" + countryOption.internalUuid,
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

      if (countriesAction.kind === "country" || countriesAction.kind === "country_ref") {
        try {
          const countryToList =
            countriesAction.kind === "country_ref"
              ? await getVpsCountryByInternalUuid(countriesAction.internalUuid)
              : countriesAction.country;

          if (countryToList === null) {
            const notFoundResult = await sendTelegramTextMessage({
              chatId: callbackChatId,
              text: "Страна для выбранного сервера не найдена.",
            });

            if (!notFoundResult.ok) {
              console.error(
                "Failed to send missing VPS country message:",
                notFoundResult.statusCode,
                notFoundResult.error,
              );
            }

            res.status(200).json({
              ok: true,
              processed: true,
              callbackHandled: true,
              sent: notFoundResult.ok,
            });
            return;
          }

          const canAskUnblockConfirm =
            countriesAction.kind === "country_ref" &&
            !telegramUser.has_purchased &&
            isUnblockCountryName(countryToList);

          if (canAskUnblockConfirm) {
            if (
              isTrialUnblockWindowExpired({
                createdAt: telegramUser.created_at,
                hasPurchased: telegramUser.has_purchased,
              })
            ) {
              const blockedResult = await sendTelegramTextMessage({
                chatId: callbackChatId,
                text: "чтобы защитить наши сервера и пользователей мы даем доступ к анблоку пробным пользователям только первые 6 часов.",
              });

              if (!blockedResult.ok) {
                console.error(
                  "Failed to send trial unblock timeout message:",
                  blockedResult.statusCode,
                  blockedResult.error,
                );
              }

              res.status(200).json({
                ok: true,
                processed: true,
                callbackHandled: true,
                sent: blockedResult.ok,
              });
              return;
            }

            const confirmResult = await sendTelegramInlineMenuMessage({
              chatId: callbackChatId,
              text:
                "Вы уверены, что вам нужны WHITELIST UNBLOCK серверы?\n" +
                "Эту функцию стоит использовать, если обычные VPN-серверы не работают.\n" +
                "Выбирайте осознанно: она помогает людям с ограничениями оставаться онлайн.",
              inlineKeyboardRows: buildUnblockTrialConfirmRows(countriesAction.internalUuid),
            });

            if (!confirmResult.ok) {
              console.error(
                "Failed to send unblock confirmation prompt:",
                confirmResult.statusCode,
                confirmResult.error,
              );
            }

            res.status(200).json({
              ok: true,
              processed: true,
              callbackHandled: true,
              sent: confirmResult.ok,
            });
            return;
          }

          const vpsListResult = await sendCountryVpsListMenu({
            chatId: callbackChatId,
            country: countryToList,
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

      if (countriesAction.kind === "unblock_confirm") {
        try {
          const countryToList = await getVpsCountryByInternalUuid(countriesAction.internalUuid);

          if (countryToList === null) {
            const notFoundResult = await sendTelegramTextMessage({
              chatId: callbackChatId,
              text: "Страна для выбранного сервера не найдена.",
            });

            if (!notFoundResult.ok) {
              console.error(
                "Failed to send missing VPS country message after unblock confirm:",
                notFoundResult.statusCode,
                notFoundResult.error,
              );
            }

            res.status(200).json({
              ok: true,
              processed: true,
              callbackHandled: true,
              sent: notFoundResult.ok,
            });
            return;
          }

          if (
            !telegramUser.has_purchased &&
            isUnblockCountryName(countryToList) &&
            isTrialUnblockWindowExpired({
              createdAt: telegramUser.created_at,
              hasPurchased: telegramUser.has_purchased,
            })
          ) {
            const blockedResult = await sendTelegramTextMessage({
              chatId: callbackChatId,
              text: "чтобы защитить наши сервера и пользователей мы даем доступ к анблоку пробным пользователям только первые 6 часов.",
            });

            if (!blockedResult.ok) {
              console.error(
                "Failed to send trial unblock timeout message after confirm:",
                blockedResult.statusCode,
                blockedResult.error,
              );
            }

            res.status(200).json({
              ok: true,
              processed: true,
              callbackHandled: true,
              sent: blockedResult.ok,
            });
            return;
          }

          const vpsListResult = await sendCountryVpsListMenu({
            chatId: callbackChatId,
            country: countryToList,
          });

          if (!vpsListResult.ok) {
            console.error(
              "Failed to send VPS list for unblock confirmation:",
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
          console.error("Failed to process unblock confirmation action:", error);
          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent: false,
          });
          return;
        }
      }

      if (countriesAction.kind === "vps") {
        try {
          const routeInfo = await getVpsRouteInfoByInternalUuid(countriesAction.internalUuid);

          if (routeInfo === null) {
            const notFoundResult = await sendTelegramTextMessage({
              chatId: callbackChatId,
              text: "Конфигурация сервера не найдена.",
            });

            if (!notFoundResult.ok) {
              console.error(
                "Failed to send missing VPS route info message:",
                notFoundResult.statusCode,
                notFoundResult.error,
              );
            }

            res.status(200).json({
              ok: true,
              processed: true,
              callbackHandled: true,
              sent: notFoundResult.ok,
            });
            return;
          }

          if (!routeInfo.isUnblock) {
            const protocolMenuResult = await sendTelegramInlineMenuMessage({
              chatId: callbackChatId,
              text: "Выберите протокол подключения:",
              inlineKeyboardRows: buildCountriesProtocolSelectionRows(countriesAction.internalUuid),
            });

            if (!protocolMenuResult.ok) {
              console.error(
                "Failed to send protocol selection menu for VPS:",
                protocolMenuResult.statusCode,
                protocolMenuResult.error,
              );
            }

            res.status(200).json({
              ok: true,
              processed: true,
              callbackHandled: true,
              sent: protocolMenuResult.ok,
            });
            return;
          }

          if (
            !telegramUser.has_purchased &&
            isTrialUnblockWindowExpired({
              createdAt: telegramUser.created_at,
              hasPurchased: telegramUser.has_purchased,
            })
          ) {
            const blockedResult = await sendTelegramTextMessage({
              chatId: callbackChatId,
              text: "чтобы защитить наши сервера и пользователей мы даем доступ к анблоку пробным пользователям только первые 6 часов.",
            });

            if (!blockedResult.ok) {
              console.error(
                "Failed to send trial unblock timeout message for unblock VPS route:",
                blockedResult.statusCode,
                blockedResult.error,
              );
            }

            res.status(200).json({
              ok: true,
              processed: true,
              callbackHandled: true,
              sent: blockedResult.ok,
            });
            return;
          }

          const sent = await sendUnblockVpsConfigMessage({
            chatId: callbackChatId,
            internalUuid: countriesAction.internalUuid,
            userInternalUuid: telegramUser.internal_uuid,
          });

          res.status(200).json({
            ok: true,
            processed: true,
            callbackHandled: true,
            sent,
          });
          return;
        } catch (error) {
          console.error("Failed to route VPS click action:", error);
          const failedResult = await sendTelegramTextMessage({
            chatId: callbackChatId,
            text: "Ошибка при подключении к серверу, попробуйте выбрать другой",
          });

          if (!failedResult.ok) {
            console.error(
              "Failed to send VPS route failure message:",
              failedResult.statusCode,
              failedResult.error,
            );
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

      if (countriesAction.kind === "help_diff") {
        const settingsProtocolsResult = await sendSettingsProtocolsMenu(callbackChatId);

        if (!settingsProtocolsResult.ok) {
          console.error(
            "Failed to send protocol difference info for countries flow:",
            settingsProtocolsResult.statusCode,
            settingsProtocolsResult.error,
          );
        }

        res.status(200).json({
          ok: true,
          processed: true,
          callbackHandled: true,
          sent: settingsProtocolsResult.ok,
        });
        return;
      }

      if (countriesAction.kind === "help_connect") {
        const howToMenuResult = await sendHowToPlatformsMenu(callbackChatId);

        if (!howToMenuResult.ok) {
          console.error(
            "Failed to send how-to menu for countries flow:",
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

      try {
        const vpsConfig = await issueOrGetUserVpsConfigUrl(
          countriesAction.internalUuid,
          telegramUser.internal_uuid,
          countriesAction.protocol,
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
            text:
              "Ваша персональная ссылка (" +
              getVpsProtocolDisplayName(countriesAction.protocol) +
              "):",
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

          const escapedConfigUrl = vpsConfig.url
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

        res.status(200).json({
          ok: true,
          processed: true,
          callbackHandled: true,
          sent,
        });
        return;
      } catch (error) {
        console.error("Failed to issue VPS config URL for user and protocol:", error);
        const failedResult = await sendTelegramTextMessage({
          chatId: callbackChatId,
          text: "Ошибка при подключении к серверу, попробуйте выбрать другой",
        });

        if (!failedResult.ok) {
          console.error(
            "Failed to send VPS connection failure message:",
            failedResult.statusCode,
            failedResult.error,
          );
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

    res.status(200).json({
      ok: true,
      processed: true,
      callbackHandled: false,
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
          } else if (paymentPayload.action === "support") {
            paymentIsValid = message.successful_payment.total_amount === paymentPayload.amount;
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
      if (paymentPayload.action === "support") {
        const supportPaymentSuccessResult = await sendTelegramTextMessage({
          chatId: message.chat.id,
          text:
            "⭐ Спасибо за поддержку!\n" +
            "Получено: " +
            String(message.successful_payment.total_amount) +
            " Telegram Stars.",
        });

        if (!supportPaymentSuccessResult.ok) {
          console.error(
            "Failed to send support payment confirmation:",
            supportPaymentSuccessResult.statusCode,
            supportPaymentSuccessResult.error,
          );
        }

        res.status(200).json({
          ok: true,
          processed: true,
          paymentApplied: true,
        });
        return;
      }

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
    getPendingAdminUserInputAction(String(message.from.id)) !== null &&
    !message.text.trim().startsWith("/")
  ) {
    const adminAction = getPendingAdminUserInputAction(String(message.from.id));
    const requesterUser = await getTelegramUserByTgId(String(message.from.id));

    if (adminAction === null || requesterUser === null || !requesterUser.isAdmin) {
      clearPendingAdminUserInput(String(message.from.id));
      const deniedResult = await sendTelegramTextMessage({
        chatId: message.chat.id,
        text: "Нет доступа к админ панели.",
      });

      if (!deniedResult.ok) {
        console.error(
          "Failed to send admin input access denied message:",
          deniedResult.statusCode,
          deniedResult.error,
        );
      }

      res.status(200).json({
        ok: true,
        processed: true,
        pendingAdminInput: false,
        sent: deniedResult.ok,
      });
      return;
    }

    const rawNicknameInput = message.text.trim();

    if (!/^@[a-zA-Z0-9_]{5,32}$/u.test(rawNicknameInput)) {
      const invalidInputResult = await sendTelegramTextMessage({
        chatId: message.chat.id,
        text: "Введите корректный логин пользователя в формате @username.",
      });

      if (!invalidInputResult.ok) {
        console.error(
          "Failed to send invalid admin user input message:",
          invalidInputResult.statusCode,
          invalidInputResult.error,
        );
      }

      res.status(200).json({
        ok: true,
        processed: true,
        pendingAdminInput: true,
        sent: invalidInputResult.ok,
      });
      return;
    }

    try {
      let successText = "";

      if (adminAction === "ban") {
        const actionResult = await banTelegramUserByNickname({
          nickname: rawNicknameInput,
        });
        successText =
          "✅ Пользователь забанен и отключен от серверов.\nТГ ID: " +
          actionResult.userTgId +
          "\nЗатронуто серверов: " +
          String(actionResult.touchedServers) +
          "\nОтключено IP: " +
          String(actionResult.disconnectedIps);
      } else if (adminAction === "unban") {
        const actionResult = await unbanTelegramUserByNickname({
          nickname: rawNicknameInput,
        });
        successText = "✅ Пользователь разбанен.\nТГ ID: " + actionResult.userTgId;
      } else {
        const actionResult = await disconnectTelegramUserConnectionsByNickname({
          nickname: rawNicknameInput,
        });
        successText =
          "✅ Соединения пользователя отключены.\nТГ ID: " +
          actionResult.userTgId +
          "\nПроверено серверов: " +
          String(actionResult.touchedServers) +
          "\nОтключено IP: " +
          String(actionResult.disconnectedIps);
      }

      clearPendingAdminUserInput(String(message.from.id));

      const successResult = await sendTelegramTextMessage({
        chatId: message.chat.id,
        text: successText,
      });

      if (!successResult.ok) {
        console.error(
          "Failed to send admin input success message:",
          successResult.statusCode,
          successResult.error,
        );
      }

      res.status(200).json({
        ok: true,
        processed: true,
        pendingAdminInput: false,
        sent: successResult.ok,
      });
      return;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "UNKNOWN";
      const userNotFound = errorMessage.includes("USER_NOT_FOUND");
      const cannotBanAdmin = errorMessage.includes("CANNOT_BAN_ADMIN");

      const failedResult = await sendTelegramTextMessage({
        chatId: message.chat.id,
        text: userNotFound
          ? "Пользователь не найден."
          : cannotBanAdmin
            ? "Нельзя забанить администратора."
            : "Не удалось выполнить действие. Проверьте логи и повторите попытку.",
      });

      if (!failedResult.ok) {
        console.error(
          "Failed to send admin input failure message:",
          failedResult.statusCode,
          failedResult.error,
        );
      }

      if (!userNotFound && !cannotBanAdmin) {
        console.error("Failed to process pending admin user action:", error);
      }

      res.status(200).json({
        ok: true,
        processed: true,
        pendingAdminInput: true,
        sent: failedResult.ok,
      });
      return;
    }
  }

  if (
    message.from !== undefined &&
    message.text !== undefined &&
    hasPendingSupportInput(String(message.from.id)) &&
    !message.text.trim().startsWith("/")
  ) {
    const rawAmountInput = message.text.trim();

    if (!/^\d+$/u.test(rawAmountInput)) {
      const invalidAmountResult = await sendTelegramTextMessage({
        chatId: message.chat.id,
        text: "Неверный формат. Допустимы только целые числа.",
      });

      if (!invalidAmountResult.ok) {
        console.error(
          "Failed to send invalid support amount message:",
          invalidAmountResult.statusCode,
          invalidAmountResult.error,
        );
      }

      res.status(200).json({
        ok: true,
        processed: true,
        pendingSupport: true,
        sent: invalidAmountResult.ok,
      });
      return;
    }

    const amount = Number.parseInt(rawAmountInput, 10);

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      const invalidPositiveResult = await sendTelegramTextMessage({
        chatId: message.chat.id,
        text: "Неверная сумма. Введите целое число больше 0.",
      });

      if (!invalidPositiveResult.ok) {
        console.error(
          "Failed to send invalid positive support amount message:",
          invalidPositiveResult.statusCode,
          invalidPositiveResult.error,
        );
      }

      res.status(200).json({
        ok: true,
        processed: true,
        pendingSupport: true,
        sent: invalidPositiveResult.ok,
      });
      return;
    }

    const supportInvoiceResult = await sendTelegramStarsInvoice({
      chatId: message.chat.id,
      title: "Поддержка проекта",
      description: "Пожертвование в Telegram Stars на развитие сервиса.",
      payload: buildSupportInvoicePayload(message.from.id, amount),
      amount,
    });

    if (!supportInvoiceResult.ok) {
      console.error(
        "Failed to send support stars invoice:",
        supportInvoiceResult.statusCode,
        supportInvoiceResult.error,
      );
      const failedResult = await sendTelegramTextMessage({
        chatId: message.chat.id,
        text: "Не удалось создать платеж, попробуйте позже.",
      });

      if (!failedResult.ok) {
        console.error(
          "Failed to send support invoice failure message:",
          failedResult.statusCode,
          failedResult.error,
        );
      }

      res.status(200).json({
        ok: true,
        processed: true,
        pendingSupport: true,
        sent: failedResult.ok,
      });
      return;
    }

    clearPendingSupportInput(String(message.from.id));
    res.status(200).json({
      ok: true,
      processed: true,
      pendingSupport: false,
      invoiceSent: true,
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
      clearPendingSupportInput(String(message.from.id));
      clearPendingAdminUserInput(String(message.from.id));
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

  if (userSyncResult.user.isBanned) {
    const bannedResult = await sendTelegramTextMessage({
      chatId: message.chat.id,
      text: getBannedUserMessage(),
    });

    if (!bannedResult.ok) {
      console.error(
        "Failed to send banned user message on command:",
        bannedResult.statusCode,
        bannedResult.error,
      );
    }

    res.status(200).json({
      ok: true,
      processed: true,
      command,
      sent: bannedResult.ok,
    });
    return;
  }

  const menuSubscriptionStatus = mapTelegramUserToMenuSubscriptionStatus(userSyncResult.user);
  const menuPayload = buildTelegramMenu(menuSubscriptionStatus, {
    isAdmin: userSyncResult.user.isAdmin,
  });
  const isStartCommand = command === "/start";

  const telegramSendResult = await sendTelegramInlineMenuMessage({
    chatId: message.chat.id,
    text: isStartCommand
      ? userSyncResult.created
        ? "Поздравляем, вы зарегистрированы! Как новому пользователю, вам начислен 1 день бесплатной подписки."
        : "Добро пожаловать в ZOZA."
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
