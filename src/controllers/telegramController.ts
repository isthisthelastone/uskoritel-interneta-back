import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import {
  answerTelegramCallbackQuery,
  editTelegramInlineMenuMessage,
  sendTelegramInlineMenuMessage,
} from "../services/telegramBotService";
import { buildTelegramMenu, type TelegramMenuKey } from "../services/telegramMenuService";
import {
  ensureTelegramUser,
  mapTelegramUserToMenuSubscriptionStatus,
} from "../services/telegramUserService";

const telegramMenuQuerySchema = z.object({
  status: z.enum(["active", "trial", "expired", "unknown"]).optional(),
});

const telegramMessageSchema = z.object({
  message_id: z.number().optional(),
  chat: z.object({
    id: z.number(),
    type: z.enum(["private", "group", "supergroup", "channel"]).optional(),
  }),
  from: z
    .object({
      id: z.number(),
      username: z.string().optional(),
    })
    .optional(),
  text: z.string().optional(),
});

const telegramCallbackQuerySchema = z.object({
  id: z.string(),
  data: z.string().optional(),
  from: z.object({
    id: z.number(),
  }),
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
  "countries",
]);

const suspiciousCommandPattern =
  /\b(?:id|user_id|chat_id|admin_id|target_id|uid)\s*[:=]\s*\d+\b|tg:\/\/user\?id=|\b\d{8,}\b/iu;

interface ParsedTelegramCommand {
  command: string | null;
  isSuspicious: boolean;
  reason?: string;
}

function getTelegramCommand(text: string | undefined): ParsedTelegramCommand {
  if (text === undefined) {
    return {
      command: null,
      isSuspicious: false,
    };
  }

  const normalizedText = text.trim();

  if (!normalizedText.startsWith("/")) {
    return {
      command: null,
      isSuspicious: false,
    };
  }

  if (normalizedText.length > 64 || suspiciousCommandPattern.test(normalizedText)) {
    return {
      command: null,
      isSuspicious: true,
      reason: "Potential ID injection payload detected.",
    };
  }

  const tokens = normalizedText.split(/\s+/u).filter((token) => token.length > 0);
  const firstToken = tokens[0] ?? "";
  const commandMatch = /^\/([a-z_]+)(?:@([a-z0-9_]{3,}))?$/iu.exec(firstToken);

  if (commandMatch === null) {
    return {
      command: null,
      isSuspicious: true,
      reason: "Malformed Telegram command.",
    };
  }

  if (tokens.length > 1) {
    return {
      command: null,
      isSuspicious: true,
      reason: "Command arguments are blocked for security.",
    };
  }

  const botMention = commandMatch.at(2)?.toLowerCase() ?? "";
  const expectedBotUsername = (process.env.BOT_USERNAME ?? "").replace(/^@/u, "").toLowerCase();

  if (
    botMention.length > 0 &&
    expectedBotUsername.length > 0 &&
    botMention !== expectedBotUsername
  ) {
    return {
      command: null,
      isSuspicious: false,
      reason: "Command is addressed to a different bot.",
    };
  }

  return {
    command: "/" + commandMatch[1].toLowerCase(),
    isSuspicious: false,
  };
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
    countries: "Список стран",
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
    const callbackChatId = callbackQuery.message?.chat.id;
    const callbackMessageId = callbackQuery.message?.message_id;
    const callbackChatType = callbackQuery.message?.chat.type;

    if (
      callbackChatId !== undefined &&
      callbackChatType === "private" &&
      callbackQuery.from.id !== callbackChatId
    ) {
      res.status(200).json({
        ok: true,
        processed: true,
        callbackHandled: false,
        reason: "Callback ownership mismatch.",
      });
      return;
    }

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

    if (menuKey === null || callbackChatId === undefined || callbackMessageId === undefined) {
      res.status(200).json({
        ok: true,
        processed: true,
        callbackHandled: menuKey !== null,
      });
      return;
    }

    const menuPayload = buildTelegramMenu("unknown");
    const editResult = await editTelegramInlineMenuMessage({
      chatId: callbackChatId,
      messageId: callbackMessageId,
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

  if (message.chat.type !== undefined && message.chat.type !== "private") {
    res.status(200).json({
      ok: true,
      processed: false,
      reason: "Only private chat commands are handled.",
    });
    return;
  }

  if (message.from !== undefined && message.from.id !== message.chat.id) {
    res.status(200).json({
      ok: true,
      processed: false,
      reason: "Sender/chat mismatch detected.",
    });
    return;
  }

  const parsedCommand = getTelegramCommand(message.text);

  if (parsedCommand.isSuspicious) {
    res.status(200).json({
      ok: true,
      processed: false,
      blocked: true,
      reason: parsedCommand.reason ?? "Blocked by security policy.",
    });
    return;
  }

  const command = parsedCommand.command;

  if (command !== "/start" && command !== "/menu") {
    res.status(200).json({
      ok: true,
      processed: false,
      reason: "Command is not handled.",
    });
    return;
  }

  if (message.from === undefined) {
    res.status(200).json({
      ok: true,
      processed: false,
      reason: "Telegram user context is missing.",
    });
    return;
  }

  let userSyncResult: Awaited<ReturnType<typeof ensureTelegramUser>>;

  try {
    userSyncResult = await ensureTelegramUser({
      tgId: String(message.from.id),
      tgNickname: message.from.username ?? null,
    });
  } catch (error) {
    console.error("Failed to sync Telegram user:", error);
    res.status(200).json({
      ok: true,
      processed: false,
      reason: "Failed to sync user profile.",
    });
    return;
  }

  const menuSubscriptionStatus = mapTelegramUserToMenuSubscriptionStatus(userSyncResult.user);
  const menuPayload = buildTelegramMenu(menuSubscriptionStatus);
  const isStartCommand = command === "/start";

  const telegramSendResult = await sendTelegramInlineMenuMessage({
    chatId: message.chat.id,
    text: isStartCommand
      ? userSyncResult.created
        ? "Welcome to Uskoritel Interneta VPN. Your profile is created."
        : "Welcome back to Uskoritel Interneta VPN."
      : "Main menu:",
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
