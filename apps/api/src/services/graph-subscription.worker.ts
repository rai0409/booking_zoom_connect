import { Injectable } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { DateTime } from "luxon";
import { prisma } from "../prisma";
import { GraphClient } from "../clients/graph.client";
import { TenantStatus } from "@prisma/client";
import { randomSecret } from "../utils/crypto";

const RENEWAL_THRESHOLD_MINUTES = 30;
const SUBSCRIPTION_DURATION_HOURS = 48;

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
    await this.syncSubscriptions(false);
  }

  async runOnce(): Promise<void> {
    await this.syncSubscriptions(true);
  }

  private async syncSubscriptions(verbose: boolean) {
    const graph = this.getGraph();
    const salespersons = await prisma.salesperson.findMany({
      where: { active: true },
      include: { tenant: true }
    });
    const eligibleSalespersons = salespersons.filter((salesperson) => salesperson.tenant.status === TenantStatus.active);

    const now = DateTime.utc();
    const desiredExpiration = now.plus({ hours: SUBSCRIPTION_DURATION_HOURS });
    const renewalCutoff = now.plus({ minutes: RENEWAL_THRESHOLD_MINUTES });
    let createdCount = 0;
    let renewedCount = 0;

    if (verbose) {
      console.log(`target_salespersons=${eligibleSalespersons.length}`);
    }

    for (const salesperson of eligibleSalespersons) {
      const resource = `users/${salesperson.graph_user_id}/events`;
      const existing = await prisma.graphSubscription.findFirst({
        where: {
          tenant_id: salesperson.tenant_id,
          salesperson_id: salesperson.id
        }
      });

      if (!existing) {
        const clientState = randomSecret();
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
        createdCount += 1;
        continue;
      }

      if (DateTime.fromJSDate(existing.expires_at) < renewalCutoff) {
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
        renewedCount += 1;
      }
    }

    if (verbose) {
      console.log(`created_subscriptions=${createdCount}`);
      console.log(`renewed_subscriptions=${renewedCount}`);
      console.log("done");
    }
  }
}
