import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import {
  answerTelegramCallbackQuery,
  editTelegramInlineMenuMessage,
  sendTelegramInlineMenuMessage,
} from "../services/telegramBotService";
import { buildTelegramMenu, type TelegramMenuKey } from "../services/telegramMenuService";

const telegramMenuQuerySchema = z.object({
  status: z.enum(["active", "trial", "expired", "unknown"]).optional(),
});

const telegramMessageSchema = z.object({
  message_id: z.number().optional(),
  chat: z.object({
    id: z.number(),
  }),
  text: z.string().optional(),
});

const telegramCallbackQuerySchema = z.object({
  id: z.string(),
  data: z.string().optional(),
  message: telegramMessageSchema.optional(),
});

const telegramUpdateSchema = z.object({
  update_id: z.number().optional(),
  message: telegramMessageSchema.optional(),
  edited_message: telegramMessageSchema.optional(),
  callback_query: telegramCallbackQuerySchema.optional(),
});

const telegramMenuKeySchema = z.enum([
  "subscription_status",
  "how_to_use",
  "faq",
  "referals",
  "gifts",
  "settings",
]);

function getTelegramCommand(text: string | undefined): string | null {
  if (text === undefined) {
    return null;
  }

  const normalizedText = text.trim();

  if (!normalizedText.startsWith("/")) {
    return null;
  }

  const firstToken = normalizedText.split(/\s+/u)[0] ?? "";
  const commandPart = firstToken.split("@")[0] ?? "";

  return commandPart.toLowerCase();
}

function getMenuKeyFromCallbackData(data: string | undefined): TelegramMenuKey | null {
  if (data === undefined || !data.startsWith("menu:")) {
    return null;
  }

  const rawMenuKey = data.slice("menu:".length);
  const parsedMenuKey = telegramMenuKeySchema.safeParse(rawMenuKey);

  if (!parsedMenuKey.success) {
    return null;
  }

  return parsedMenuKey.data;
}

function getMenuSectionText(menuKey: TelegramMenuKey): string {
  const menuSectionTextMap: Record<TelegramMenuKey, string> = {
    subscription_status: "Subscription status: ⚪ Unknown. We will sync your real status soon.",
    how_to_use: "How to use: choose a VPN location, connect, and keep this bot for quick controls.",
    faq: "FAQ: we will add common VPN setup and troubleshooting answers here.",
    referals: "Referals: invite friends and receive bonus days after successful activation.",
    gifts: "Gifts: seasonal promo codes and gift subscriptions will appear here.",
    settings: "Settings: language, notifications, and account preferences.",
  };

  return menuSectionTextMap[menuKey];
}

export function requireTelegramSecret(req: Request, res: Response, next: NextFunction): void {
  const expectedSecret = process.env.TG_SECRET;

  if (expectedSecret === undefined || expectedSecret.length === 0) {
    res.status(500).json({
      ok: false,
      message: "TG_SECRET is not configured.",
    });
    return;
  }

  const providedSecret =
    req.header("x-telegram-secret") ?? req.header("x-telegram-bot-api-secret-token");

  if (providedSecret !== expectedSecret) {
    res.status(401).json({
      ok: false,
      message: "Unauthorized: invalid Telegram secret.",
    });
    return;
  }

  next();
}

export function getTelegramMenu(req: Request, res: Response): void {
  const parsedQuery = telegramMenuQuerySchema.safeParse(req.query);

  if (!parsedQuery.success) {
    res.status(400).json({
      ok: false,
      message: "Invalid query parameters.",
      errors: z.treeifyError(parsedQuery.error),
    });
    return;
  }

  const subscriptionStatus = parsedQuery.data.status ?? "unknown";
  const payload = buildTelegramMenu(subscriptionStatus);

  res.status(200).json({
    ok: true,
    data: payload,
  });
}

export async function handleTelegramMenuWebhook(req: Request, res: Response): Promise<void> {
  const parsedUpdate = telegramUpdateSchema.safeParse(req.body);

  if (!parsedUpdate.success) {
    res.status(200).json({
      ok: true,
      processed: false,
      reason: "Invalid Telegram update payload.",
    });
    return;
  }

  const callbackQuery = parsedUpdate.data.callback_query;

  if (callbackQuery !== undefined) {
    const menuKey = getMenuKeyFromCallbackData(callbackQuery.data);

    const callbackAnswerResult = await answerTelegramCallbackQuery({
      callbackQueryId: callbackQuery.id,
      text: menuKey === null ? "Unknown action." : "Opening section...",
      showAlert: false,
    });

    if (!callbackAnswerResult.ok) {
      console.error(
        "Failed to answer Telegram callback query:",
        callbackAnswerResult.statusCode,
        callbackAnswerResult.error,
      );
    }

    if (menuKey === null || callbackQuery.message?.message_id === undefined) {
      res.status(200).json({
        ok: true,
        processed: true,
        callbackHandled: menuKey !== null,
      });
      return;
    }

    const menuPayload = buildTelegramMenu("unknown");
    const editResult = await editTelegramInlineMenuMessage({
      chatId: callbackQuery.message.chat.id,
      messageId: callbackQuery.message.message_id,
      text: getMenuSectionText(menuKey),
      inlineKeyboardRows: menuPayload.inlineKeyboardRows,
    });

    if (!editResult.ok) {
      console.error(
        "Failed to edit Telegram menu message:",
        editResult.statusCode,
        editResult.error,
      );
    }

    res.status(200).json({
      ok: true,
      processed: true,
      callbackHandled: true,
      edited: editResult.ok,
    });
    return;
  }

  const message = parsedUpdate.data.message ?? parsedUpdate.data.edited_message;

  if (message === undefined) {
    res.status(200).json({
      ok: true,
      processed: false,
      reason: "No message in update.",
    });
    return;
  }

  const command = getTelegramCommand(message.text);

  if (command !== "/start" && command !== "/menu") {
    res.status(200).json({
      ok: true,
      processed: false,
      reason: "Command is not handled.",
    });
    return;
  }

  const menuPayload = buildTelegramMenu("unknown");
  const isStartCommand = command === "/start";

  const telegramSendResult = await sendTelegramInlineMenuMessage({
    chatId: message.chat.id,
    text: isStartCommand ? "Welcome to Uskoritel Interneta VPN. Use the menu below." : "Main menu:",
    inlineKeyboardRows: menuPayload.inlineKeyboardRows,
  });

  if (!telegramSendResult.ok) {
    console.error(
      "Failed to send Telegram menu:",
      telegramSendResult.statusCode,
      telegramSendResult.error,
    );
  }

  res.status(200).json({
    ok: true,
    processed: true,
    command,
    sent: telegramSendResult.ok,
  });
}
