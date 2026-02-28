import type { NextFunction, Request, Response } from "express";

export function requireAdminSecret(req: Request, res: Response, next: NextFunction): void {
  const expectedSecret = process.env.AUTH_JWT_SECRET;

  if (expectedSecret === undefined || expectedSecret.length === 0) {
    res.status(500).json({
      ok: false,
      message: "AUTH_JWT_SECRET is not configured.",
    });
    return;
  }

  const providedSecret = req.header("x-admin-secret");

  if (providedSecret !== expectedSecret) {
    res.status(401).json({
      ok: false,
      message: "Unauthorized: invalid admin secret.",
    });
    return;
  }

  next();
}
