import type { Request, Response } from "express";
import { runVpsSshCommand } from "../../../services/vpsSshService";

export async function testVpsSshConnection(_req: Request, res: Response): Promise<void> {
  try {
    const hostnameResult = await runVpsSshCommand("hostname");
    const whoamiResult = await runVpsSshCommand("whoami");

    res.status(200).json({
      ok: true,
      data: {
        host: process.env.VPS_SSH_HOST ?? null,
        hostname: hostnameResult.stdout.trim(),
        user: whoamiResult.stdout.trim(),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown SSH error.";

    res.status(500).json({
      ok: false,
      message: "VPS SSH connection failed.",
      error: message,
    });
  }
}
