import { Injectable } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { DateTime } from "luxon";
import { prisma } from "../prisma";
import { GraphClient } from "../clients/graph.client";
import { TenantStatus } from "@prisma/client";

const RENEWAL_THRESHOLD_MINUTES = 30;
const SUBSCRIPTION_DURATION_HOURS = 12;

@Injectable()
export class GraphSubscriptionWorker {
  private graph = new GraphClient();

  @Interval(60_000)
  async ensureSubscriptions() {
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

      const resource = `/users/${salesperson.graph_user_id}/events`;
      const existing = await prisma.graphSubscription.findFirst({
        where: {
          tenant_id: salesperson.tenant_id,
          salesperson_id: salesperson.id
        }
      });

      if (!existing) {
        const created = await this.graph.createSubscription({
          resource,
          expirationUtc: desiredExpiration.toISO() || ""
        });

        await prisma.graphSubscription.create({
          data: {
            tenant_id: salesperson.tenant_id,
            salesperson_id: salesperson.id,
            subscription_id: created.subscriptionId,
            resource,
            expires_at: DateTime.fromISO(created.expiresAtUtc, { zone: "utc" }).toJSDate()
          }
        });
        continue;
      }

      if (DateTime.fromJSDate(existing.expires_at) < renewalCutoff) {
        const renewed = await this.graph.renewSubscription(
          existing.subscription_id,
          desiredExpiration.toISO() || ""
        );

        await prisma.graphSubscription.update({
          where: { id: existing.id },
          data: {
            expires_at: DateTime.fromISO(renewed.expiresAtUtc, { zone: "utc" }).toJSDate()
          }
        });
      }
    }
  }
}
