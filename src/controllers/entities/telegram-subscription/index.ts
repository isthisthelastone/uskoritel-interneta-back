import { sendTelegramInlineMenuMessage } from "../../../services/telegramBotService";

export function hasAccessToServers(
  subscriptionStatus: "live" | "ending" | null,
  subscriptionActive: boolean,
): boolean {
  return subscriptionActive || subscriptionStatus === "live" || subscriptionStatus === "ending";
}

export function buildSubscriptionStatusTextFromDb(
  subscriptionStatus: "live" | "ending" | null,
  subscriptionUntill: string | null,
): string {
  if (subscriptionStatus === "live") {
    return [
      "🟢 Статус подписки: LIVE",
      subscriptionUntill !== null ? "Подписка до: " + subscriptionUntill : null,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }

  if (subscriptionStatus === "ending") {
    return [
      "🟠 Статус подписки: ENDING",
      subscriptionUntill !== null ? "Подписка до: " + subscriptionUntill : null,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }

  return "🔴 Статус подписки: Отсутствует";
}

export async function sendSubscriptionRequiredForServersMessage(chatId: number) {
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
