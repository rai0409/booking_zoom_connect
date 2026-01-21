import jwt from "jsonwebtoken";
import { config } from "../config";

export type TokenPurpose = "verify" | "cancel" | "reschedule";

export type BookingTokenPayload = {
  iss: string;
  aud: string;
  exp: number;
  jti: string;
  tenant_id: string;
  booking_id: string;
  purpose: TokenPurpose;
};

export function signBookingToken(payload: Omit<BookingTokenPayload, "iss" | "aud">): string {
  return jwt.sign(
    { ...payload, iss: config.baseUrl, aud: "booking-system" },
    getJwtSecret(),
    { algorithm: "HS256", noTimestamp: true }
  );
}

export function verifyBookingToken(token: string): BookingTokenPayload {
  const decoded = jwt.verify(token, getJwtSecret(), {
    issuer: config.baseUrl,
    audience: "booking-system"
  }) as BookingTokenPayload;
  return decoded;
}

function getJwtSecret(): string {
  return process.env.JWT_SECRET || "dev-secret";
}
