import type { TelegramInlineButton } from "../../../services/telegramMenuService";

export function getFaqMenuInlineKeyboardRows(): TelegramInlineButton[][] {
  return [
    [
      { text: "📧 Связаться по почте", callbackData: "faq:email" },
      { text: "💬 Вступайте в чат", url: "https://t.me/zozavpn" },
    ],
    [
      { text: "🛟 Написать в поддержку", url: "https://t.me/zozasupp" },
      { text: "📜 Правила сервиса", callbackData: "faq:rules" },
    ],
    [
      {
        text: "📄 Публичная оферта",
        url: "https://telegra.ph/Publichnaya-oferta-starlink-fast-internet-bot-02-26",
      },
    ],
  ];
}

export function getFaqActionText(actionKind: "email" | "rules"): string {
  if (actionKind === "email") {
    return "Вы можете написать нам на почту starlink.echo@outlook.com";
  }

  return [
    "☑️ Продолжая пользоваться нашим сервисом, вы подтверждаете согласие со следующими условиями:",
    "• Не нарушать законы Российской Федерации.",
    "• Не передавать и не публиковать свой ключ доступа. При нарушении ключ будет отключён, а аккаунт заблокирован.",
    "• Не заниматься спамом и флудом в боте и службе поддержки. Обращения обрабатываются по очереди, срок ответа может составлять до 48 часов.",
    "",
    "English version (line below):",
    "",
    "☑️ By continuing to use our service, you confirm that you agree to the following terms:",
    "• Do not violate the laws of the Russian Federation.",
    "• Do not share or publish your access key. If you break this rule, the key will be deactivated and your account will be blocked.",
    "• Do not spam or flood the bot or support chat. Requests are handled in order, and the response time can be up to 48 hours.",
  ].join("\n");
}
