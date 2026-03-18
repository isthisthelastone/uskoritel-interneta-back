import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import pino from "pino";
import pinoHttp from "pino-http";
import {
  getTelegramMenu,
  handleTelegramMenuWebhook,
  requireTelegramSecret,
} from "./controllers/features/telegram";
import { requireAdminSecret, syncVpsConnectionsNow } from "./controllers/features/vps";

function getTrustProxyValue(): boolean | number {
  const rawValue = process.env.TRUST_PROXY?.trim().toLowerCase();

  if (rawValue === undefined || rawValue.length === 0) {
    return process.env.NODE_ENV === "production" ? 1 : false;
  }

  if (rawValue === "true") {
    return true;
  }

  if (rawValue === "false") {
    return false;
  }

  const parsedNumber = Number.parseInt(rawValue, 10);

  if (Number.isFinite(parsedNumber) && parsedNumber >= 0) {
    return parsedNumber;
  }

  return process.env.NODE_ENV === "production" ? 1 : false;
}

export function createApp() {
  const app = express();
  const logger = pino({
    level: process.env.NODE_ENV === "production" ? "info" : "debug",
    redact: {
      paths: [
        'req.headers["x-admin-secret"]',
        'req.headers["x-telegram-secret"]',
        'req.headers["x-telegram-bot-api-secret-token"]',
      ],
      censor: "[REDACTED]",
    },
  });
  app.set("trust proxy", getTrustProxyValue());

  app.use(
    pinoHttp({
      logger,
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      origin: process.env.APP_URL ?? true,
    }),
  );
  app.use(express.json());
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      max: 120,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  app.get("/health", (_req, res) => {
    res.status(200).json({
      ok: true,
      service: "uskoritel-interneta-back",
    });
  });

  app.get("/api/telegram/menu", requireTelegramSecret, getTelegramMenu);
  app.post("/api/telegram/menu", requireTelegramSecret, handleTelegramMenuWebhook);
  app.post("/api/vps/connections/sync", requireAdminSecret, syncVpsConnectionsNow);

  return app;
}
