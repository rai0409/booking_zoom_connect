import "reflect-metadata";
import { randomUUID } from "node:crypto";
import * as dotenv from "dotenv";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { GraphSubscriptionWorker } from "../services/graph-subscription.worker";

const g = globalThis as any;
if (!g.crypto) g.crypto = {};
if (typeof g.crypto.randomUUID !== "function") {
  g.crypto.randomUUID = randomUUID;
}

function assertApiBaseUrl(): string {
  const apiBaseUrl = String(process.env.API_BASE_URL || "").trim();
  if (!apiBaseUrl) {
    throw new Error("API_BASE_URL is required");
  }

  const lower = apiBaseUrl.toLowerCase();
  if (lower.includes("localhost") || lower.includes("127.0.0.1") || lower.includes("0.0.0.0")) {
    throw new Error("API_BASE_URL must not use localhost/127.0.0.1/0.0.0.0");
  }

  if (lower.startsWith("http://")) {
    console.warn(`warning: API_BASE_URL is not https: ${apiBaseUrl}`);
  }

  return apiBaseUrl;
}

async function main() {
  dotenv.config({ path: process.env.ENV_FILE || ".env" });

  const apiBaseUrl = assertApiBaseUrl();
  const notificationUrl = `${apiBaseUrl.replace(/\/$/, "")}/v1/webhooks/graph`;
  console.log(`API_BASE_URL=${apiBaseUrl}`);
  console.log(`notificationUrl=${notificationUrl}`);

  const app = await NestFactory.createApplicationContext(AppModule);
  try {
    const worker = app.get(GraphSubscriptionWorker);
    await worker.runOnce();
    await app.close();
    process.exit(0);
  } catch (err) {
    await app.close().catch(() => {});
    console.error(err instanceof Error ? err.stack || err.message : String(err));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
