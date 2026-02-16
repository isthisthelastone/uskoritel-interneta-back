import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { buildTelegramMenu } from "../services/telegramMenuService";

const telegramMenuQuerySchema = z.object({
  status: z.enum(["active", "trial", "expired", "unknown"]).optional(),
});

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
