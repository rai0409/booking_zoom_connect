import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const REQUEST_ID_HEADER = "x-request-id";

export type RequestWithId = Request & { requestId?: string };

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const fromHeader = Array.isArray(incoming) ? incoming[0] : incoming;
  const requestId = typeof fromHeader === "string" && fromHeader.trim() ? fromHeader : randomUUID();

  (req as RequestWithId).requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  next();
}
