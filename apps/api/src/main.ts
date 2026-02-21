import "reflect-metadata";
import { randomUUID } from "node:crypto";

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
