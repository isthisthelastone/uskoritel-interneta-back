import type { Request, Response } from "express";
import { z } from "zod";
import { buildTelegramMenu } from "../../../services/telegramMenuService";

const telegramMenuQuerySchema = z.object({
  status: z.enum(["active", "trial", "expired", "unknown"]).optional(),
});

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
