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
  };

  return menuSectionTextMap[menuKey];
}

function getSpeedEmoji(speedMbPerSec: number): string {
  if (speedMbPerSec < 50) {
    return "🔴";
  }

  if (speedMbPerSec < 100) {
    return "🟠";
  }

  return "🟢";
}

function getLoadEmoji(numberOfConnections: number): string {
  if (numberOfConnections <= 10) {
    return "🟢";
  }

  if (numberOfConnections <= 50) {
    return "🟠";
  }

  return "🔴";
}

function trimButtonLabel(value: string): string {
  if (value.length <= TELEGRAM_INLINE_BUTTON_TEXT_MAX_LENGTH) {
    return value;
  }

  return value.slice(0, TELEGRAM_INLINE_BUTTON_TEXT_MAX_LENGTH - 1).trimEnd() + "…";
}

export function buildVpsButtonText(input: {
  nickname: string | null;
  internalUuid: string;
  currentSpeed: number;
  numberOfConnections: number;
}): string {
  const displayName = input.nickname ?? "VPS " + input.internalUuid.slice(0, 8).toUpperCase();
  const speed = Number.isFinite(input.currentSpeed) ? Math.max(0, input.currentSpeed) : 0;
  const connections = Number.isFinite(input.numberOfConnections)
    ? Math.max(0, Math.round(input.numberOfConnections))
    : 0;
  const speedEmoji = getSpeedEmoji(speed);
  const loadEmoji = getLoadEmoji(connections);
  const speedLabel = Math.round(speed).toString();
  const line =
    displayName +
    " | Скорость " +
    speedEmoji +
    " " +
    speedLabel +
    " | Загруженность " +
    loadEmoji +
    " " +
    String(connections);

  return trimButtonLabel(line);
}
