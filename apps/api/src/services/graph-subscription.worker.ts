import { Injectable } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { DateTime } from "luxon";
import { prisma } from "../prisma";
import { GraphClient } from "../clients/graph.client";
import { TenantStatus } from "@prisma/client";
import { randomSecret } from "../utils/crypto";
import { config } from "../config";
import { log } from "../utils/logger";

const RENEWAL_THRESHOLD_MINUTES = 30;
const SUBSCRIPTION_DURATION_HOURS = 48;
let warnedMissingMailbox = false;
let warnedDisabled = false;
let warnedMailbox404 = false;

@Injectable()
export class GraphSubscriptionWorker {
  private graph: GraphClient | null = null;
  private getGraph() {
    if (!this.graph) this.graph = new GraphClient();
    return this.graph;
  }

  @Interval(60_000)
  async ensureSubscriptions() {
    if (process.env.GRAPH_ENABLED === "0") return;
    if (process.env.GRAPH_SUBSCRIPTION_WORKER_ENABLED === "0") {
      if (!warnedDisabled) {
        log("info", "graph_subscription_worker_disabled", {});
        warnedDisabled = true;
      }
      return;
    }
    if (config.graphMock) return;
    if (!config.msSharedMailbox || config.msSharedMailbox === "change-me" || !config.msSharedMailbox.includes("@")) {
      if (!warnedMissingMailbox) {
        log("warn", "graph_subscription_worker_skipped_invalid_ms_shared_mailbox", {});
        warnedMissingMailbox = true;
      }
      return;
    }
    const graph = this.getGraph();
    const salespersons = await prisma.salesperson.findMany({
      where: { active: true },
      include: { tenant: true }
    });

    const now = DateTime.utc();
    const desiredExpiration = now.plus({ hours: SUBSCRIPTION_DURATION_HOURS });
    const renewalCutoff = now.plus({ minutes: RENEWAL_THRESHOLD_MINUTES });

    for (const salesperson of salespersons) {
      if (salesperson.tenant.status !== TenantStatus.active) {
        continue;
      }

      const resource = `users/${salesperson.graph_user_id}/events`;
      const existing = await prisma.graphSubscription.findFirst({
        where: {
          tenant_id: salesperson.tenant_id,
          salesperson_id: salesperson.id
        }
      });

      if (!existing) {
        const clientState = randomSecret();
        try {
          const created = await graph.createSubscription(
            salesperson.tenant.m365_tenant_id || "",
            {
              resource,
              expirationUtc: desiredExpiration.toISO() || "",
              clientState
            }
          );

          await prisma.graphSubscription.create({
            data: {
              tenant_id: salesperson.tenant_id,
              salesperson_id: salesperson.id,
              subscription_id: created.subscriptionId,
              resource,
              expires_at: DateTime.fromISO(created.expiresAtUtc, { zone: "utc" }).toJSDate(),
              client_state: clientState
            }
          });
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          const lower = err.toLowerCase();
          if (
            lower.includes("mailbox is either inactive") ||
            lower.includes("soft-deleted") ||
            lower.includes("hosted on-premise")
          ) {
            if (!warnedMailbox404) {
              log("warn", "graph_subscription_worker_mailbox_unavailable", { err });
              warnedMailbox404 = true;
            }
            return;
          }
          log("warn", "graph_subscription_worker_error", { err });
          return;
        }
        continue;
      }

      if (DateTime.fromJSDate(existing.expires_at) < renewalCutoff) {
        try {
          const renewed = await graph.renewSubscription(
            salesperson.tenant.m365_tenant_id || "",
            existing.subscription_id,
            desiredExpiration.toISO() || ""
          );

          await prisma.graphSubscription.update({
            where: { id: existing.id },
            data: {
              expires_at: DateTime.fromISO(renewed.expiresAtUtc, { zone: "utc" }).toJSDate()
            }
          });
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          log("warn", "graph_subscription_worker_error", { err });
          return;
        }
      }
    }
  }
}
