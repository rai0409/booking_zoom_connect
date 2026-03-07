import "dotenv/config";
import { BookingService } from "../src/services/booking.service";

function readArg(name: string, fallback?: string) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] || fallback;
}

async function main() {
  const tenant = readArg("tenant");
  const limit = Number(readArg("limit", "50"));

  if (!tenant) {
    throw new Error("--tenant is required");
  }

  const service = new BookingService();
  const result = await service.resendConfirmationEmails(tenant, limit);
  console.log(JSON.stringify(result));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
