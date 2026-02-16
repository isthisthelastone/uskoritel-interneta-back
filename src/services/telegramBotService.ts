interface TelegramSendMessageResult {
  ok: boolean;
  statusCode: number;
  error?: string;
}

interface SendTelegramMenuMessageParams {
  chatId: number;
  text: string;
  keyboardRows: string[][];
}

function buildTelegramApiUrl(method: string): string | null {
  const botToken = process.env.BOT_TOKEN;

  if (botToken === undefined || botToken.length === 0) {
    return null;
  }

  return "https://api.telegram.org/bot" + botToken + "/" + method;
}

export async function sendTelegramMenuMessage(
  params: SendTelegramMenuMessageParams,
): Promise<TelegramSendMessageResult> {
  const endpoint = buildTelegramApiUrl("sendMessage");

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
    body: JSON.stringify({
      chat_id: params.chatId,
      text: params.text,
      reply_markup: {
        keyboard: params.keyboardRows.map((row) => row.map((label) => ({ text: label }))),
        resize_keyboard: true,
        one_time_keyboard: false,
        is_persistent: true,
      },
    }),
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
