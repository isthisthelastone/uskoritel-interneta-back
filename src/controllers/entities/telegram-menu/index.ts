import type { TelegramMenuKey } from "../../../services/telegramMenuService";

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
