export type TelegramSubscriptionStatus = "active" | "trial" | "expired" | "unknown";

export interface TelegramMenuItem {
  key: "subscription_status" | "how_to_use" | "faq" | "referals" | "gifts" | "settings";
  label: string;
  sizeFr: 0.5 | 1;
}

export interface TelegramMenuResponse {
  subscriptionStatus: TelegramSubscriptionStatus;
  menu: TelegramMenuItem[];
  keyboardRows: TelegramMenuItem[][];
}

const subscriptionStatusEmojiMap: Record<TelegramSubscriptionStatus, string> = {
  active: "🟢",
  trial: "🟡",
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
      label: `${statusEmoji} SUBSCRIPTION STATUS`,
      sizeFr: 1,
    },
    {
      key: "how_to_use",
      label: "📘 HOW TO USE",
      sizeFr: 0.5,
    },
    {
      key: "faq",
      label: "❓ FAQ",
      sizeFr: 0.5,
    },
    {
      key: "referals",
      label: "🤝 REFERALS",
      sizeFr: 0.5,
    },
    {
      key: "gifts",
      label: "🎁 GIFTS",
      sizeFr: 0.5,
    },
    {
      key: "settings",
      label: "⚙️ SETTINGS",
      sizeFr: 1,
    },
  ];

  return {
    subscriptionStatus,
    menu,
    keyboardRows: [[menu[0]], [menu[1], menu[2]], [menu[3], menu[4]], [menu[5]]],
  };
}
