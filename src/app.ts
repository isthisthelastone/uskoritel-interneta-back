import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import pino from "pino";
import pinoHttp from "pino-http";
import { getTelegramMenu, requireTelegramSecret } from "./controllers/telegramController";

export function createApp() {
  const app = express();
  const logger = pino({
    level: process.env.NODE_ENV === "production" ? "info" : "debug",
  });

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

  return app;
}
