import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { sendTelegramMenuMessage } from "../services/telegramBotService";
import { buildTelegramMenu } from "../services/telegramMenuService";

const telegramMenuQuerySchema = z.object({
  status: z.enum(["active", "trial", "expired", "unknown"]).optional(),
});

const telegramMessageSchema = z.object({
  chat: z.object({
    id: z.number(),
  }),
  text: z.string().optional(),
});

const telegramUpdateSchema = z.object({
  update_id: z.number().optional(),
  message: telegramMessageSchema.optional(),
  edited_message: telegramMessageSchema.optional(),
});

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
  const keyboardRows = menuPayload.keyboardRows.map((row) => row.map((item) => item.label));
  const isStartCommand = command === "/start";

  const telegramSendResult = await sendTelegramMenuMessage({
    chatId: message.chat.id,
    text: isStartCommand ? "Welcome to Uskoritel Interneta VPN. Use the menu below." : "Main menu:",
    keyboardRows,
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
