import {
  claimCryptoBotInvoiceProcessing,
  getCryptoBotInvoiceByInvoiceId,
  getRemoteCryptoBotInvoicesByIds,
  listActiveCryptoBotInvoices,
  type CryptoBotInvoiceRecord,
  type CryptoBotRemoteInvoice,
  updateCryptoBotInvoiceAfterPaid,
  updateCryptoBotInvoiceStatus,
} from "./cryptoBotService";
import {
  applyReferralRewardForPurchase,
  finalizeTelegramPaidSubscriptionPurchase,
} from "./telegramUserService";
import { sendTelegramTextMessage } from "./telegramBotService";

interface CryptoBotSyncResult {
  processedInvoices: number;
  paidInvoices: number;
  expiredInvoices: number;
  failedInvoices: number;
}

export type CryptoBotInvoiceCheckStatus =
  | "not_found"
  | "forbidden"
  | "pending"
  | "paid"
  | "already_paid"
  | "expired"
  | "cancelled"
  | "failed";

let syncIntervalTimer: NodeJS.Timeout | null = null;
let isSyncRunning = false;
let isSyncDisabledBySchemaError = false;
const cryptoBotSyncDebugLogsEnabled =
  process.env.CRYPTO_BOT_DEBUG_LOGS?.trim().toLowerCase() === "true";

function logCryptoBotSyncDebug(event: string, data?: Record<string, unknown>): void {
  if (!cryptoBotSyncDebugLogsEnabled) {
    return;
  }

  if (data === undefined) {
    console.log("[cryptobot-sync][debug]", event);
    return;
  }

  console.log("[cryptobot-sync][debug]", event, JSON.stringify(data));
}

function getSyncIntervalMs(): number {
  const rawInterval = process.env.CRYPTO_BOT_SYNC_INTERVAL_MS;
  const parsedInterval = rawInterval !== undefined ? Number.parseInt(rawInterval, 10) : NaN;

  if (!Number.isFinite(parsedInterval) || parsedInterval < 10_000) {
    return 60_000;
  }

  return parsedInterval;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (items.length === 0) {
    return [];
  }

  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function normalizeRemoteStatus(
  status: string,
): "active" | "paid" | "expired" | "cancelled" | "failed" {
  if (status === "active") {
    return "active";
  }

  if (status === "paid") {
    return "paid";
  }

  if (status === "expired") {
    return "expired";
  }

  if (status === "cancelled" || status === "canceled") {
    return "cancelled";
  }

  return "failed";
}

async function notifyPaidSubscription(
  tgId: string,
  months: number,
  subscriptionUntil: string | null,
) {
  const chatId = Number.parseInt(tgId, 10);

  if (!Number.isSafeInteger(chatId)) {
    return;
  }

  const notifyResult = await sendTelegramTextMessage({
    chatId,
    text: [
      "✅ CryptoBot платеж успешно подтвержден.",
      "Оплачено на: " + String(months) + " мес.",
      "🟢 Статус подписки: LIVE",
      subscriptionUntil !== null ? "Действительна до: " + subscriptionUntil : null,
    ]
      .filter((line): line is string => line !== null)
      .join("\n"),
  });

  if (!notifyResult.ok) {
    console.error(
      "Failed to send CryptoBot payment success confirmation:",
      notifyResult.statusCode,
      notifyResult.error,
    );
  }
}

async function applyPaidInvoice(
  localInvoice: CryptoBotInvoiceRecord,
  remoteInvoice: CryptoBotRemoteInvoice,
  notifyUser: boolean,
): Promise<boolean> {
  const claimed = await claimCryptoBotInvoiceProcessing(localInvoice.internalUuid);

  if (!claimed) {
    return false;
  }

  try {
    const updatedUser = await finalizeTelegramPaidSubscriptionPurchase({
      tgId: localInvoice.tgId,
      tgNickname: null,
      months: localInvoice.months,
    });

    try {
      await applyReferralRewardForPurchase({
        payerTgId: localInvoice.tgId,
        payerTgNickname: null,
        purchaseAmountUsd: localInvoice.amountUsd,
      });
    } catch (referralError) {
      console.error("Failed to apply referral reward after CryptoBot payment:", referralError);
    }

    await updateCryptoBotInvoiceAfterPaid({
      internalUuid: localInvoice.internalUuid,
      rawPayload: remoteInvoice.raw,
    });

    if (notifyUser) {
      await notifyPaidSubscription(
        localInvoice.tgId,
        localInvoice.months,
        updatedUser.subscription_untill,
      );
    }

    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown apply error.";

    await updateCryptoBotInvoiceStatus({
      internalUuid: localInvoice.internalUuid,
      status: "failed",
      rawPayload: remoteInvoice.raw,
      lastError: errorMessage,
    });

    throw error;
  }
}

async function syncCryptoBotInvoices(notifyUser: boolean): Promise<CryptoBotSyncResult> {
  const activeInvoices = await listActiveCryptoBotInvoices(300);

  if (activeInvoices.length === 0) {
    return {
      processedInvoices: 0,
      paidInvoices: 0,
      expiredInvoices: 0,
      failedInvoices: 0,
    };
  }

  const invoiceIds = activeInvoices.map((invoice) => invoice.invoiceId);
  const remoteInvoices: CryptoBotRemoteInvoice[] = [];

  for (const chunk of chunkArray(invoiceIds, 100)) {
    const chunkInvoices = await getRemoteCryptoBotInvoicesByIds(chunk);
    remoteInvoices.push(...chunkInvoices);
  }

  const remoteById = new Map<number, CryptoBotRemoteInvoice>();

  for (const remoteInvoice of remoteInvoices) {
    remoteById.set(remoteInvoice.invoiceId, remoteInvoice);
  }

  let paidInvoices = 0;
  let expiredInvoices = 0;
  let failedInvoices = 0;

  for (const localInvoice of activeInvoices) {
    const remoteInvoice = remoteById.get(localInvoice.invoiceId);

    if (remoteInvoice === undefined) {
      continue;
    }

    const normalizedStatus = normalizeRemoteStatus(remoteInvoice.status);

    if (normalizedStatus === "active") {
      continue;
    }

    if (normalizedStatus === "expired") {
      await updateCryptoBotInvoiceStatus({
        internalUuid: localInvoice.internalUuid,
        status: "expired",
        rawPayload: remoteInvoice.raw,
      });
      expiredInvoices += 1;
      continue;
    }

    if (normalizedStatus === "cancelled") {
      await updateCryptoBotInvoiceStatus({
        internalUuid: localInvoice.internalUuid,
        status: "cancelled",
        rawPayload: remoteInvoice.raw,
      });
      continue;
    }

    if (normalizedStatus === "failed") {
      await updateCryptoBotInvoiceStatus({
        internalUuid: localInvoice.internalUuid,
        status: "failed",
        rawPayload: remoteInvoice.raw,
        lastError: "Unsupported remote invoice status: " + remoteInvoice.status,
      });
      failedInvoices += 1;
      continue;
    }

    try {
      const applied = await applyPaidInvoice(localInvoice, remoteInvoice, notifyUser);

      if (applied) {
        paidInvoices += 1;
      }
    } catch (error) {
      failedInvoices += 1;
      console.error(
        "Failed to apply paid CryptoBot invoice:",
        localInvoice.invoiceId,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return {
    processedInvoices: activeInvoices.length,
    paidInvoices,
    expiredInvoices,
    failedInvoices,
  };
}

async function runSyncSafely(trigger: string): Promise<void> {
  if (isSyncDisabledBySchemaError) {
    return;
  }

  if (isSyncRunning) {
    return;
  }

  isSyncRunning = true;

  try {
    const result = await syncCryptoBotInvoices(true);
    console.log(
      "[cryptobot-sync]",
      trigger,
      "processedInvoices=" + String(result.processedInvoices),
      "paidInvoices=" + String(result.paidInvoices),
      "expiredInvoices=" + String(result.expiredInvoices),
      "failedInvoices=" + String(result.failedInvoices),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('relation "crypto_bot_invoices" does not exist')
    ) {
      isSyncDisabledBySchemaError = true;
      console.error(
        "[cryptobot-sync] disabled: crypto_bot_invoices table is missing. Run latest Supabase migration.",
      );
      return;
    }

    if (error instanceof Error) {
      console.error("[cryptobot-sync]", trigger, "failed:", error.message);
    } else {
      console.error("[cryptobot-sync]", trigger, "failed:", error);
    }
  } finally {
    isSyncRunning = false;
  }
}

export async function checkCryptoBotInvoiceByIdForUser(params: {
  tgId: string;
  invoiceId: number;
}): Promise<CryptoBotInvoiceCheckStatus> {
  logCryptoBotSyncDebug("manual_check_start", {
    tgId: params.tgId,
    invoiceId: params.invoiceId,
  });
  const invoice = await getCryptoBotInvoiceByInvoiceId(params.invoiceId);

  if (invoice === null) {
    logCryptoBotSyncDebug("manual_check_result", {
      status: "not_found",
      invoiceId: params.invoiceId,
    });
    return "not_found";
  }

  if (invoice.tgId !== params.tgId) {
    logCryptoBotSyncDebug("manual_check_result", {
      status: "forbidden",
      invoiceId: params.invoiceId,
      invoiceTgId: invoice.tgId,
    });
    return "forbidden";
  }

  if (invoice.status === "paid") {
    logCryptoBotSyncDebug("manual_check_result", {
      status: "already_paid",
      invoiceId: invoice.invoiceId,
    });
    return "already_paid";
  }

  if (invoice.status === "expired") {
    logCryptoBotSyncDebug("manual_check_result", {
      status: "expired",
      invoiceId: invoice.invoiceId,
    });
    return "expired";
  }

  if (invoice.status === "cancelled") {
    logCryptoBotSyncDebug("manual_check_result", {
      status: "cancelled",
      invoiceId: invoice.invoiceId,
    });
    return "cancelled";
  }

  if (invoice.status === "failed") {
    logCryptoBotSyncDebug("manual_check_result", {
      status: "failed",
      invoiceId: invoice.invoiceId,
    });
    return "failed";
  }

  const remoteInvoices = await getRemoteCryptoBotInvoicesByIds([invoice.invoiceId]);

  if (remoteInvoices.length === 0) {
    logCryptoBotSyncDebug("manual_check_result", {
      status: "pending",
      invoiceId: invoice.invoiceId,
    });
    return "pending";
  }

  const remoteInvoice = remoteInvoices[0];

  const normalizedStatus = normalizeRemoteStatus(remoteInvoice.status);

  if (normalizedStatus === "active") {
    logCryptoBotSyncDebug("manual_check_result", {
      status: "pending",
      invoiceId: invoice.invoiceId,
    });
    return "pending";
  }

  if (normalizedStatus === "expired") {
    await updateCryptoBotInvoiceStatus({
      internalUuid: invoice.internalUuid,
      status: "expired",
      rawPayload: remoteInvoice.raw,
    });
    return "expired";
  }

  if (normalizedStatus === "cancelled") {
    await updateCryptoBotInvoiceStatus({
      internalUuid: invoice.internalUuid,
      status: "cancelled",
      rawPayload: remoteInvoice.raw,
    });
    return "cancelled";
  }

  if (normalizedStatus === "failed") {
    await updateCryptoBotInvoiceStatus({
      internalUuid: invoice.internalUuid,
      status: "failed",
      rawPayload: remoteInvoice.raw,
      lastError: "Unsupported remote invoice status: " + remoteInvoice.status,
    });
    return "failed";
  }

  await applyPaidInvoice(invoice, remoteInvoice, true);
  logCryptoBotSyncDebug("manual_check_result", { status: "paid", invoiceId: invoice.invoiceId });
  return "paid";
}

export function startCryptoBotPaymentsSyncJob(): void {
  if (syncIntervalTimer !== null) {
    return;
  }

  const token = process.env.CRYPTO_BOT_API?.trim();

  if (token === undefined || token.length === 0) {
    console.log("[cryptobot-sync] disabled: CRYPTO_BOT_API is not configured");
    return;
  }

  const syncEnabledRaw = process.env.CRYPTO_BOT_SYNC_ENABLED?.trim().toLowerCase();

  if (syncEnabledRaw === "false") {
    console.log("[cryptobot-sync] disabled by CRYPTO_BOT_SYNC_ENABLED=false");
    return;
  }

  const intervalMs = getSyncIntervalMs();
  console.log("[cryptobot-sync] starting; intervalMs=" + String(intervalMs));
  void runSyncSafely("startup");

  syncIntervalTimer = setInterval(() => {
    void runSyncSafely("interval");
  }, intervalMs);

  syncIntervalTimer.unref();
}
