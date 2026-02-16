import type { TelegramInlineButton } from "./telegramMenuService";

interface TelegramApiResult {
  ok: boolean;
  statusCode: number;
  error?: string;
}

interface SendTelegramInlineMenuMessageParams {
  chatId: number;
  text: string;
  inlineKeyboardRows: TelegramInlineButton[][];
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

  if (!response.ok) {
    return {
      ok: false,
      statusCode: response.status,
      error: await response.text(),
    };
  }

  return {
    ok: true,
    statusCode: response.status,
  };
}

export async function sendTelegramInlineMenuMessage(
  params: SendTelegramInlineMenuMessageParams,
): Promise<TelegramApiResult> {
  return postTelegramApi("sendMessage", {
    chat_id: params.chatId,
    text: params.text,
    reply_markup: {
      inline_keyboard: params.inlineKeyboardRows.map((row) =>
        row.map((button) => ({
          text: button.text,
          callback_data: button.callbackData,
        })),
      ),
    },
  });
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
        row.map((button) => ({
          text: button.text,
          callback_data: button.callbackData,
        })),
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
