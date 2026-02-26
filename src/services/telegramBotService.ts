import type { TelegramInlineButton } from "./telegramMenuService";

interface TelegramApiResult {
  ok: boolean;
  statusCode: number;
  error?: string;
  messageId?: number;
}

interface SendTelegramInlineMenuMessageParams {
  chatId: number;
  text: string;
  inlineKeyboardRows: TelegramInlineButton[][];
}

interface SendTelegramTextMessageParams {
  chatId: number;
  text: string;
}

interface SendTelegramPhotoMessageParams {
  chatId: number;
  photoUrl: string;
  caption?: string;
}

interface SendTelegramStarsInvoiceParams {
  chatId: number;
  title: string;
  description: string;
  payload: string;
  amount: number;
}

interface EditTelegramInlineMenuMessageParams {
  chatId: number;
  messageId: number;
  text: string;
  inlineKeyboardRows: TelegramInlineButton[][];
}

interface AnswerTelegramCallbackQueryParams {
  callbackQueryId: string;
  text?: string;
  showAlert?: boolean;
}

interface AnswerTelegramPreCheckoutQueryParams {
  preCheckoutQueryId: string;
  ok: boolean;
  errorMessage?: string;
}

interface DeleteTelegramMessageParams {
  chatId: number;
  messageId: number;
}

interface ClearTrackedTelegramChatHistoryResult {
  ok: boolean;
  attemptedCount: number;
  deletedCount: number;
  failedCount: number;
}

const trackedMessageIdsByChat = new Map<number, number[]>();
const maxTrackedMessagesPerChat = 500;

function buildTelegramInlineButtonPayload(button: TelegramInlineButton): Record<string, string> {
  if (button.url !== undefined && button.url.length > 0) {
    return {
      text: button.text,
      url: button.url,
    };
  }

  return {
    text: button.text,
    callback_data: button.callbackData ?? "noop",
  };
}

function trackMessageId(chatId: number, messageId: number): void {
  const trackedIds = trackedMessageIdsByChat.get(chatId) ?? [];

  if (trackedIds.includes(messageId)) {
    return;
  }

  trackedIds.push(messageId);

  if (trackedIds.length > maxTrackedMessagesPerChat) {
    trackedIds.splice(0, trackedIds.length - maxTrackedMessagesPerChat);
  }

  trackedMessageIdsByChat.set(chatId, trackedIds);
}

function untrackMessageId(chatId: number, messageId: number): void {
  const trackedIds = trackedMessageIdsByChat.get(chatId);

  if (trackedIds === undefined) {
    return;
  }

  const nextTrackedIds = trackedIds.filter((trackedId) => trackedId !== messageId);

  if (nextTrackedIds.length === 0) {
    trackedMessageIdsByChat.delete(chatId);
    return;
  }

  trackedMessageIdsByChat.set(chatId, nextTrackedIds);
}

function readErrorFromTelegramResponse(parsedBody: unknown): string | null {
  if (typeof parsedBody !== "object" || parsedBody === null) {
    return null;
  }

  const body = parsedBody as Record<string, unknown>;
  if (body.ok !== false) {
    return null;
  }

  const description =
    typeof body.description === "string" && body.description.length > 0
      ? body.description
      : "Telegram API returned ok=false.";
  const errorCode = typeof body.error_code === "number" ? String(body.error_code) + " " : "";

  return errorCode + description;
}

function readMessageIdFromTelegramResponse(parsedBody: unknown): number | undefined {
  if (typeof parsedBody !== "object" || parsedBody === null) {
    return undefined;
  }

  const body = parsedBody as Record<string, unknown>;
  const result = body.result;

  if (typeof result !== "object" || result === null) {
    return undefined;
  }

  const messageId = (result as Record<string, unknown>).message_id;

  if (typeof messageId === "number" && Number.isInteger(messageId)) {
    return messageId;
  }

  return undefined;
}

function buildTelegramApiUrl(method: string): string | null {
  const botToken = process.env.BOT_TOKEN;

  if (botToken === undefined || botToken.length === 0) {
    return null;
  }

  return "https://api.telegram.org/bot" + botToken + "/" + method;
}

async function postTelegramApi(
  method: string,
  payload: Record<string, boolean | number | string | Record<string, unknown> | unknown[]>,
): Promise<TelegramApiResult> {
  const endpoint = buildTelegramApiUrl(method);

  if (endpoint === null) {
    return {
      ok: false,
      statusCode: 500,
      error: "BOT_TOKEN is not configured.",
    };
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  let parsedBody: unknown = null;

  if (responseText.length > 0) {
    try {
      parsedBody = JSON.parse(responseText);
    } catch {
      parsedBody = null;
    }
  }

  if (!response.ok) {
    return {
      ok: false,
      statusCode: response.status,
      error: responseText,
    };
  }

  const telegramApiError = readErrorFromTelegramResponse(parsedBody);

  if (telegramApiError !== null) {
    return {
      ok: false,
      statusCode: response.status,
      error: telegramApiError,
    };
  }

  return {
    ok: true,
    statusCode: response.status,
    messageId: readMessageIdFromTelegramResponse(parsedBody),
  };
}

export async function sendTelegramInlineMenuMessage(
  params: SendTelegramInlineMenuMessageParams,
): Promise<TelegramApiResult> {
  const result = await postTelegramApi("sendMessage", {
    chat_id: params.chatId,
    text: params.text,
    reply_markup: {
      inline_keyboard: params.inlineKeyboardRows.map((row) =>
        row.map((button) => buildTelegramInlineButtonPayload(button)),
      ),
    },
  });

  if (result.ok && result.messageId !== undefined) {
    trackMessageId(params.chatId, result.messageId);
  }

  return result;
}

export async function sendTelegramTextMessage(
  params: SendTelegramTextMessageParams,
): Promise<TelegramApiResult> {
  const result = await postTelegramApi("sendMessage", {
    chat_id: params.chatId,
    text: params.text,
  });

  if (result.ok && result.messageId !== undefined) {
    trackMessageId(params.chatId, result.messageId);
  }

  return result;
}

export async function sendTelegramPhotoMessage(
  params: SendTelegramPhotoMessageParams,
): Promise<TelegramApiResult> {
  const result = await postTelegramApi("sendPhoto", {
    chat_id: params.chatId,
    photo: params.photoUrl,
    caption: params.caption ?? "",
  });

  if (result.ok && result.messageId !== undefined) {
    trackMessageId(params.chatId, result.messageId);
  }

  return result;
}

export async function sendTelegramStarsInvoice(
  params: SendTelegramStarsInvoiceParams,
): Promise<TelegramApiResult> {
  const result = await postTelegramApi("sendInvoice", {
    chat_id: params.chatId,
    title: params.title,
    description: params.description,
    payload: params.payload,
    provider_token: "",
    currency: "XTR",
    prices: [
      {
        label: params.title,
        amount: params.amount,
      },
    ],
    start_parameter: "vpn-subscription",
  });

  if (result.ok && result.messageId !== undefined) {
    trackMessageId(params.chatId, result.messageId);
  }

  return result;
}

export async function editTelegramInlineMenuMessage(
  params: EditTelegramInlineMenuMessageParams,
): Promise<TelegramApiResult> {
  return postTelegramApi("editMessageText", {
    chat_id: params.chatId,
    message_id: params.messageId,
    text: params.text,
    reply_markup: {
      inline_keyboard: params.inlineKeyboardRows.map((row) =>
        row.map((button) => buildTelegramInlineButtonPayload(button)),
      ),
    },
  });
}

export async function answerTelegramCallbackQuery(
  params: AnswerTelegramCallbackQueryParams,
): Promise<TelegramApiResult> {
  return postTelegramApi("answerCallbackQuery", {
    callback_query_id: params.callbackQueryId,
    text: params.text ?? "",
    show_alert: params.showAlert ?? false,
  });
}

export async function answerTelegramPreCheckoutQuery(
  params: AnswerTelegramPreCheckoutQueryParams,
): Promise<TelegramApiResult> {
  const payload: Record<string, boolean | string> = {
    pre_checkout_query_id: params.preCheckoutQueryId,
    ok: params.ok,
  };

  if (!params.ok) {
    payload.error_message = params.errorMessage ?? "Payment can't be processed right now.";
  }

  return postTelegramApi("answerPreCheckoutQuery", payload);
}

export async function deleteTelegramMessage(
  params: DeleteTelegramMessageParams,
): Promise<TelegramApiResult> {
  const result = await postTelegramApi("deleteMessage", {
    chat_id: params.chatId,
    message_id: params.messageId,
  });

  if (result.ok) {
    untrackMessageId(params.chatId, params.messageId);
  }

  return result;
}

export async function clearTrackedTelegramChatHistory(
  chatId: number,
): Promise<ClearTrackedTelegramChatHistoryResult> {
  const trackedIds = trackedMessageIdsByChat.get(chatId);

  if (trackedIds === undefined || trackedIds.length === 0) {
    return {
      ok: true,
      attemptedCount: 0,
      deletedCount: 0,
      failedCount: 0,
    };
  }

  let deletedCount = 0;
  let failedCount = 0;

  const idsToDelete = [...trackedIds].sort((left, right) => right - left);

  for (const messageId of idsToDelete) {
    const deleteResult = await deleteTelegramMessage({
      chatId,
      messageId,
    });

    if (deleteResult.ok) {
      deletedCount += 1;
    } else {
      failedCount += 1;
    }
  }

  return {
    ok: failedCount === 0,
    attemptedCount: idsToDelete.length,
    deletedCount,
    failedCount,
  };
}

export async function clearTelegramChatHistoryBySweep(params: {
  chatId: number;
  upToMessageId: number;
  maxMessagesToSweep?: number;
}): Promise<ClearTrackedTelegramChatHistoryResult> {
  const sweepLimitRaw = params.maxMessagesToSweep ?? 5000;
  const sweepLimit = Math.max(1, Math.min(10000, Math.trunc(sweepLimitRaw)));
  const startMessageId = Math.max(1, Math.trunc(params.upToMessageId));
  const endMessageId = Math.max(1, startMessageId - sweepLimit + 1);

  const trackedIds = trackedMessageIdsByChat.get(params.chatId) ?? [];
  const idsToDeleteSet = new Set<number>(trackedIds);

  for (let messageId = startMessageId; messageId >= endMessageId; messageId -= 1) {
    idsToDeleteSet.add(messageId);
  }

  const idsToDelete = Array.from(idsToDeleteSet).sort((left, right) => right - left);

  if (idsToDelete.length === 0) {
    return {
      ok: true,
      attemptedCount: 0,
      deletedCount: 0,
      failedCount: 0,
    };
  }

  let deletedCount = 0;
  let failedCount = 0;

  for (const messageId of idsToDelete) {
    const deleteResult = await deleteTelegramMessage({
      chatId: params.chatId,
      messageId,
    });

    if (deleteResult.ok) {
      deletedCount += 1;
      continue;
    }

    failedCount += 1;
  }

  return {
    ok: failedCount === 0,
    attemptedCount: idsToDelete.length,
    deletedCount,
    failedCount,
  };
}
