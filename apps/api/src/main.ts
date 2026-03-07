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
import { ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module";
import { createPublicRateLimiter } from "./middleware/public-rate-limit";
import { requestIdMiddleware } from "./middleware/request-id.middleware";
import * as dotenv from "dotenv";

async function bootstrap() {
  dotenv.config({ path: process.env.ENV_FILE || ".env" });
  const nodeEnv = (process.env.NODE_ENV || "").toLowerCase();
  const queueDriver = (process.env.QUEUE_DRIVER || "memory").toLowerCase();
  const graphEnabled = (process.env.GRAPH_ENABLED ?? "0") !== "0";
  const graphMock = (process.env.GRAPH_MOCK ?? "false").toLowerCase() === "true";

  if (nodeEnv === "production") {
    if (queueDriver === "memory") {
      // eslint-disable-next-line no-console
      console.error("Refusing to start in production with QUEUE_DRIVER=memory");
      process.exit(1);
    }
    if (graphEnabled && graphMock) {
      // eslint-disable-next-line no-console
      console.error("Refusing to start in production with GRAPH_ENABLED=1 and GRAPH_MOCK=true");
      process.exit(1);
    }
  }

  const app = await NestFactory.create(AppModule);
  app.use(requestIdMiddleware);
  app.use(createPublicRateLimiter());
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true
  }));
  const port = process.env.PORT ? Number(process.env.PORT) : 4000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`API listening on :${port}`);
}

bootstrap();
