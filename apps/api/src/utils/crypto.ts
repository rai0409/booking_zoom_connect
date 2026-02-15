import crypto from "node:crypto";

/**
 * Generate a random secret suitable for Graph subscription clientState, etc.
 * Default: 16 bytes => 32 hex chars.
 */
export function randomSecret(bytes: number = 16): string {
  return crypto.randomBytes(bytes).toString("hex");
}
