import {
  sendTelegramPhotoMessage,
  sendTelegramTextMessage,
} from "../../../services/telegramBotService";
import type { HowToPlatform } from "../../entities";

async function sendPhotoWithFallback(params: {
  chatId: number;
  imageUrl: string;
  caption: string;
  contextLabel: string;
}): Promise<boolean> {
  const photoResult = await sendTelegramPhotoMessage({
    chatId: params.chatId,
    photoUrl: params.imageUrl,
    caption: params.caption,
  });

  if (photoResult.ok) {
    return true;
  }

  console.error(
    "Failed to send " + params.contextLabel + " image:",
    photoResult.statusCode,
    photoResult.error,
  );

  const fallbackResult = await sendTelegramTextMessage({
    chatId: params.chatId,
    text: [params.imageUrl, "", params.caption].join("\n"),
  });

  if (!fallbackResult.ok) {
    console.error(
      "Failed to send " + params.contextLabel + " fallback message:",
      fallbackResult.statusCode,
      fallbackResult.error,
    );
  }

  return fallbackResult.ok;
}

export async function handleHowToGuideAction(
  chatId: number,
  platform: HowToPlatform,
): Promise<boolean> {
  if (platform === "ios") {
    const iosGuideCaption = [
      "Скачай приложение для айфона по ссылке:",
      "https://apps.apple.com/ge/app/fair-vpn/id1533873488",
      "",
      "И подключись по инструкции с картинки.",
      "Или воспользуйся запасным приложением:",
      "https://apps.apple.com/ge/app/v2raytun/id6476628951",
    ].join("\n");
    return sendPhotoWithFallback({
      chatId,
      imageUrl: "https://ibb.co/LXrq7Z0w",
      caption: iosGuideCaption,
      contextLabel: "ios how-to",
    });
  }

  if (platform === "windows") {
    const windowsGuideCaption = [
      "Для установки VPN windows приложения откройте ссылку:",
      "https://github.com/2dust/v2rayN/releases/latest",
      "",
      "1) Далее пролистайте вниз страницы и выберите версию программы “v2rayN-windows-64-SelfContained.zip”",
      "2) нажмите вверхнем левом углу программы “Servers” и “Import Share Links from clipboard (Ctrl +V)”",
      "3) осталось только включить VPN нажав кнопку “Enable Tun”",
    ].join("\n");
    return sendPhotoWithFallback({
      chatId,
      imageUrl: "https://ibb.co/TxDvSjvw",
      caption: windowsGuideCaption,
      contextLabel: "windows how-to",
    });
  }

  if (platform === "macos") {
    const macosGuideCaption = [
      "1. Скачайте v2RayTun из AppStore:",
      "https://apps.apple.com/ge/app/v2raytun/id6476628951",
      "или запасное приложение:",
      "https://apps.apple.com/ge/app/fair-vpn/id1533873488",
      "",
      "2. Откройте приложение v2RayTun и нажмите + в правом верхнем углу.",
      "",
      "3. Выберите опцию Import from clipboard (Импорт из буфера обмена).",
      "",
      "4. Для подключения нажмите кнопку питания и разрешите добавить конфигурацию VPN в настройках устройства.",
    ].join("\n");
    return sendPhotoWithFallback({
      chatId,
      imageUrl: "https://ibb.co/67qgyc9L",
      caption: macosGuideCaption,
      contextLabel: "macos how-to",
    });
  }

  if (platform === "android_tv") {
    const androidTvSteps = [
      {
        imageUrl: "https://ibb.co/8ndc1NBL",
        text: "Качаем приложение v2RayTun на телевизор",
      },
      {
        imageUrl: "https://ibb.co/27HGxF5B",
        text: "Устанавливаем v2RayTun",
      },
      {
        imageUrl: "https://ibb.co/v43g1zGW",
        text: "Открываем приложение v2RayTun после установки",
      },
      {
        imageUrl: "https://ibb.co/qLRpJ50w",
        text: 'В приложении v2RayTun нажимаем на "Управление"',
      },
      {
        imageUrl: "https://ibb.co/cKHBCzxJ",
        text: "Выбираем ручной ввод",
      },
      {
        imageUrl: "https://ibb.co/KpnwQSMc",
        text: [
          "Открываем приложение Google TV на телефоне и подключаемся к телевизору.",
          "",
          "(скачать из App Store / Google если его нет - с его помощью вы легко сможете вставить текст на телевизор с телефона и использовать свой телефон как пульт)",
        ].join("\n"),
      },
      {
        imageUrl: "https://ibb.co/ybVfbZ3",
        text: "Вставляем конфигурацию на телефоне и жмём ок",
      },
    ];

    let allStepsSent = true;

    for (const step of androidTvSteps) {
      const stepSent = await sendPhotoWithFallback({
        chatId,
        imageUrl: step.imageUrl,
        caption: step.text,
        contextLabel: "android tv step",
      });

      if (!stepSent) {
        allStepsSent = false;
      }
    }

    return allStepsSent;
  }

  const androidGuideCaption = [
    "Скачай приложение для андроида по ссылке:",
    "https://play.google.com/store/apps/details?id=com.v2raytun.android",
    "",
    "Если у тебя нет PlayMarket - скачай приложение здесь:",
    "https://apkpure.com/ru/v2raytun/com.v2raytun.android",
    "",
    "Скопируй свою ссылку на VPN",
    "И подключись по инструкции с картинки",
  ].join("\n");
  return sendPhotoWithFallback({
    chatId,
    imageUrl: "https://ibb.co/TDF1rD6F",
    caption: androidGuideCaption,
    contextLabel: "android how-to",
  });
}
