export type TelegramSubscriptionStatus = "active" | "trial" | "expired" | "unknown";
export type TelegramMenuKey =
  | "subscription_status"
  | "how_to_use"
  | "faq"
  | "referals"
  | "gifts"
  | "settings"
  | "countries";

export interface TelegramMenuItem {
  key: TelegramMenuKey;
  label: string;
  sizeFr: 0.5 | 1;
  callbackData: `menu:${TelegramMenuKey}`;
}

export interface TelegramInlineButton {
  text: string;
  callbackData?: string;
  url?: string;
}

export interface TelegramMenuResponse {
  subscriptionStatus: TelegramSubscriptionStatus;
  menu: TelegramMenuItem[];
  keyboardRows: TelegramMenuItem[][];
  inlineKeyboardRows: TelegramInlineButton[][];
}

const subscriptionStatusEmojiMap: Record<TelegramSubscriptionStatus, string> = {
  active: "🟢",
  trial: "🟠",
  expired: "🔴",
  unknown: "⚪",
};

export function buildTelegramMenu(
  subscriptionStatus: TelegramSubscriptionStatus,
): TelegramMenuResponse {
  const statusEmoji = subscriptionStatusEmojiMap[subscriptionStatus];

  const menu: TelegramMenuItem[] = [
    {
      key: "subscription_status",
      label: `${statusEmoji} Статус подписки`,
      sizeFr: 1,
      callbackData: "menu:subscription_status",
    },
    {
      key: "how_to_use",
      label: "📘 Как пользоваться",
      sizeFr: 0.5,
      callbackData: "menu:how_to_use",
    },
    {
      key: "faq",
      label: "❓ Вопросы",
      sizeFr: 0.5,
      callbackData: "menu:faq",
    },
    {
      key: "referals",
      label: "🤝 Рефералка",
      sizeFr: 0.5,
      callbackData: "menu:referals",
    },
    {
      key: "gifts",
      label: "🎁 Подарки",
      sizeFr: 0.5,
      callbackData: "menu:gifts",
    },
    {
      key: "settings",
      label: "⚙️ Настройки",
      sizeFr: 0.5,
      callbackData: "menu:settings",
    },
    {
      key: "countries",
      label: "Список стран 🇭🇷 🇷🇸🇨🇿",
      sizeFr: 0.5,
      callbackData: "menu:countries",
    },
  ];

  const keyboardRows = [[menu[0]], [menu[1], menu[2]], [menu[3], menu[4]], [menu[5], menu[6]]];

  return {
    subscriptionStatus,
    menu,
    keyboardRows,
    inlineKeyboardRows: keyboardRows.map((row) =>
      row.map((item) => ({
        text: item.label,
        callbackData: item.callbackData,
      })),
    ),
  };
}
