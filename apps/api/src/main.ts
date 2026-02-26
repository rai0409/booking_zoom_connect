import "reflect-metadata";
import { randomUUID } from "node:crypto";

if (process.env.BOOT_TRACE === "1") {
  // eslint-disable-next-line no-console
  console.log(`[boot] main.ts start pid=${process.pid} cwd=${process.cwd()}`);
}

const g = globalThis as any;
if (!g.crypto) g.crypto = {};
if (typeof g.crypto.randomUUID !== "function") {
  g.crypto.randomUUID = randomUUID;
}
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { createPublicRateLimiter } from "./middleware/public-rate-limit";
import * as dotenv from "dotenv";

async function bootstrap() {
  dotenv.config({ path: process.env.ENV_FILE || ".env" });
  const app = await NestFactory.create(AppModule);
  app.use(createPublicRateLimiter());
  const port = process.env.PORT ? Number(process.env.PORT) : 4000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`API listening on :${port}`);
}

bootstrap();
