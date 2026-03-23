import type { TelegramMenuKey } from "../../../services/telegramMenuService";

const TELEGRAM_INLINE_BUTTON_TEXT_MAX_LENGTH = 64;

export function getMenuSectionText(menuKey: TelegramMenuKey): string {
  const menuSectionTextMap: Record<TelegramMenuKey, string> = {
    subscription_status:
      "Статус подписки: ⚪ Неизвестно. Скоро мы синхронизируем ваш реальный статус.",
    how_to_use:
      "Как пользоваться: выберите VPN локацию, подключитесь и держите этого бота под рукой для быстрых команд.",
    faq: "FAQ: здесь мы добавим частые ответы по настройке VPN и решению проблем.",
    referals: "Рефералы: приглашайте друзей и получайте бонусные дни после успешной активации.",
    gifts: "Подарки и промокоды",
    settings: "Настройки: язык, уведомления и параметры аккаунта.",
    countries: "Список стран",
    admin_panel: "Админ панель: раздел в разработке.",
  };

  return menuSectionTextMap[menuKey];
}

function getSpeedEmoji(speedMbPerSec: number): string {
  if (speedMbPerSec < 50) {
    return "🟠";
  }

  if (speedMbPerSec < 100) {
    return "🟡";
  }

  return "🟢";
}

function getLoadEmoji(numberOfConnections: number): string {
  if (numberOfConnections <= 10) {
    return "🟢";
  }

  if (numberOfConnections <= 20) {
    return "🟡";
  }

  if (numberOfConnections <= 25) {
    return "🟠";
  }

  return "🔴";
}

function getLoadSuffix(numberOfConnections: number): string {
  if (numberOfConnections >= 26) {
    return " FULL";
  }

  return "";
}

function getNormalizedConnections(rawValue: number): number {
  if (!Number.isFinite(rawValue)) {
    return 0;
  }

  return Math.max(0, Math.round(rawValue));
}

function getLoadIndicator(numberOfConnections: number): string {
  const normalizedConnections = getNormalizedConnections(numberOfConnections);
  const loadEmoji = getLoadEmoji(normalizedConnections);
  const loadSuffix = getLoadSuffix(normalizedConnections);

  return loadEmoji + loadSuffix;
}

function trimButtonLabel(value: string): string {
  if (value.length <= TELEGRAM_INLINE_BUTTON_TEXT_MAX_LENGTH) {
    return value;
  }

  return value.slice(0, TELEGRAM_INLINE_BUTTON_TEXT_MAX_LENGTH - 1).trimEnd() + "…";
}

function buildUnblockShortName(rawNickname: string | null, fallbackInternalUuid: string): string {
  const nickname = rawNickname?.trim() ?? "";

  if (nickname.length > 0) {
    const taggedMatch = nickname.match(/#\s*(\d+)/iu);

    if (taggedMatch !== null) {
      return "UNBLOCK #" + taggedMatch[1];
    }

    const numericMatch = nickname.match(/(\d+)/u);

    if (numericMatch !== null) {
      return "UNBLOCK #" + numericMatch[1];
    }
  }

  return "UNBLOCK #" + fallbackInternalUuid.slice(0, 4).toUpperCase();
}

export function buildVpsButtonText(input: {
  nickname: string | null;
  internalUuid: string;
  countryEmoji?: string;
  isUnblock?: boolean;
  currentSpeed: number;
  numberOfConnections: number;
}): string {
  const displayName =
    input.isUnblock === true
      ? buildUnblockShortName(input.nickname, input.internalUuid)
      : (input.nickname ?? "VPS " + input.internalUuid.slice(0, 8).toUpperCase());
  const speed = Number.isFinite(input.currentSpeed) ? Math.max(0, input.currentSpeed) : 0;
  const connections = getNormalizedConnections(input.numberOfConnections);
  const speedEmoji = getSpeedEmoji(speed);
  const loadEmoji = getLoadIndicator(connections);
  const line = displayName + " | Скорость " + speedEmoji + " | Люди " + loadEmoji;

  return trimButtonLabel(line);
}
