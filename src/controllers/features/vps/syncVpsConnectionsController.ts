import type { Request, Response } from "express";
import { syncVpsCurrentConnections } from "../../../services/vpsConnectionsSyncService";

export async function syncVpsConnectionsNow(_req: Request, res: Response): Promise<void> {
  try {
    const result = await syncVpsCurrentConnections();

    res.status(200).json({
      ok: true,
      data: result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown sync error.";

    res.status(500).json({
      ok: false,
      message: "VPS connections sync failed.",
      error: message,
    });
  }
}
