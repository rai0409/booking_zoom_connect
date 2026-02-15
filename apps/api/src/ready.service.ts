import { Injectable } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

const DEFAULT_REQUIRED_TABLES = "tenants,bookings,holds";
const DEFAULT_REQUIRED_COLUMNS =
  "bookings.status,holds.expires_at_utc,bookings.customer_reinvite_required";
type Check = { ok: boolean; detail?: string };

function csv(name: string, fallback: string) {
  const v = (process.env[name] ?? fallback).trim();
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

@Injectable()
export class ReadyService {
  async check(): Promise<{ ok: boolean; ts: string; checks: Record<string, Check> }> {
    const checks: Record<string, Check> = {};
    const ts = new Date().toISOString();
    try {

    // 1) 必須 env
    const graphEnabled = (process.env.GRAPH_ENABLED ?? "0") !== "0";

    const requiredEnvs = csv(
      "READY_REQUIRED_ENVS",
      // 必要ならここを増やせる。Graphは enabled のときだけ別途追加。
      "DATABASE_URL,JWT_SECRET,ADMIN_API_KEY",
    );

    const requiredEnvsGraph = csv("READY_REQUIRED_ENVS_GRAPH", "TENANT_ID,CLIENT_ID,CLIENT_SECRET");

    for (const k of requiredEnvs) {
      checks[`env:${k}`] = process.env[k] ? { ok: true } : { ok: false, detail: "missing" };
    }
    if (graphEnabled) {
      for (const k of requiredEnvsGraph) {
        checks[`env:${k}`] = process.env[k] ? { ok: true } : { ok: false, detail: "missing" };
      }
    } else {
      checks["env:graph_required_skipped"] = { ok: true, detail: "GRAPH_ENABLED=0" };
    }

    // 2) DB 接続 + schema(必須テーブル/カラム)
    const prisma = new PrismaClient();
    try {
      await prisma.$connect();
      await prisma.$queryRaw`select 1 as ok`;
      checks["db:connect"] = { ok: true };

      // 2-1) 必須テーブル（必要なら env で上書き）
      const requiredTables = csv("READY_REQUIRED_TABLES", DEFAULT_REQUIRED_TABLES);
      for (const t of requiredTables) {
        try {
          const rows = await prisma.$queryRaw<
            Array<{ exists: boolean }>
          >`select exists(
              select 1 from information_schema.tables
              where table_schema='public' and lower(table_name)=lower(${t})
            ) as exists`;
          checks[`db:table:${t}`] = rows?.[0]?.exists ? { ok: true } : { ok: false, detail: "missing" };
        } catch (e: any) {
          checks[`db:table:${t}`] = { ok: false, detail: e?.message ?? String(e) };
        }
      }

      // 2-2) 必須カラム（必要なら env で上書き）
      // 形式: "booking.customer_reinvite_required,hold.expires_at_utc"
      const requiredCols = csv(
        "READY_REQUIRED_COLUMNS",
        DEFAULT_REQUIRED_COLUMNS,
      );
      for (const spec of requiredCols) {
        const [table, col] = spec.split(".", 2);
        if (!table || !col) {
          checks[`db:column:${spec}`] = { ok: false, detail: "invalid format (use table.column)" };
          continue;
        }
        try {
          const rows = await prisma.$queryRaw<
            Array<{ exists: boolean }>
          >`select exists(
              select 1 from information_schema.columns
              where table_schema='public'
                and lower(table_name)=lower(${table})
                and lower(column_name)=lower(${col})
            ) as exists`;
          checks[`db:column:${table}.${col}`] = rows?.[0]?.exists ? { ok: true } : { ok: false, detail: "missing" };
        } catch (e: any) {
          checks[`db:column:${table}.${col}`] = { ok: false, detail: e?.message ?? String(e) };
        }
      }
    } catch (e: any) {
      checks["db:connect"] = { ok: false, detail: e?.message ?? String(e) };
    } finally {
      await prisma.$disconnect().catch(() => void 0);
    }

      const ok = Object.values(checks).every((c) => c.ok);
      return { ok, ts, checks };
    } catch (e: any) {
      checks["ready:exception"] = { ok: false, detail: e?.message ?? String(e) };
      return { ok: false, ts, checks };
    }
  }
}
