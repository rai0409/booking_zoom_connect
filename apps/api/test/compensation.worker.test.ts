import { DateTime } from "luxon";
import { randomUUID } from "crypto";
import { prisma } from "../src/prisma";
import { CompensationWorker } from "../src/services/compensation.worker";

async function resetDb() {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "compensation_jobs",
      "idempotency_keys",
      "webhook_jobs",
      "graph_subscriptions",
      "audit_logs",
      "tracking_events",
      "graph_events",
      "meetings",
      "holds",
      "bookings",
      "customers",
      "salespersons",
      "tenants"
    RESTART IDENTITY CASCADE;
  `);
}

describe("CompensationWorker", () => {
  const worker = new CompensationWorker();

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test("processes pending graph_failed_after_zoom job", async () => {
    const tenant = await prisma.tenant.create({
      data: { name: "Acme", slug: "acme", status: "active" }
    });
    const salesperson = await prisma.salesperson.create({
      data: {
        tenant_id: tenant.id,
        graph_user_id: "graph-user-001",
        display_name: "Alex",
        timezone: "Asia/Tokyo",
        active: true
      }
    });
    const customer = await prisma.customer.create({
      data: {
        tenant_id: tenant.id,
        email: "comp@example.com"
      }
    });
    const booking = await prisma.booking.create({
      data: {
        tenant_id: tenant.id,
        salesperson_id: salesperson.id,
        customer_id: customer.id,
        start_at_utc: DateTime.utc().plus({ hours: 4 }).toJSDate(),
        end_at_utc: DateTime.utc().plus({ hours: 5 }).toJSDate(),
        status: "confirmed",
        idempotency_key: "comp-job-booking"
      }
    });
    await prisma.meeting.create({
      data: {
        booking_id: booking.id,
        provider: "zoom",
        provider_meeting_id: "zoom-provider-id",
        join_url: "https://zoom.example/join",
        start_url: "https://zoom.example/start"
      }
    });

    const jobId = randomUUID();
    await prisma.$executeRaw`
      INSERT INTO "compensation_jobs" (
        "id",
        "tenant_id",
        "booking_id",
        "status",
        "reason",
        "payload",
        "attempts",
        "created_at",
        "updated_at"
      )
      VALUES (
        ${jobId}::uuid,
        ${tenant.id}::uuid,
        ${booking.id}::uuid,
        'pending',
        'graph_failed_after_zoom',
        ${JSON.stringify({ zoom_meeting_id: "zoom-provider-id" })}::jsonb,
        0,
        NOW(),
        NOW()
      )
    `;
    await worker.tick();

    const [refreshedJob] = await prisma.$queryRaw<
      Array<{ status: string; attempts: number; last_error: string | null; next_run_at: Date | null }>
    >`
      SELECT "status", "attempts", "last_error", "next_run_at"
      FROM "compensation_jobs"
      WHERE "id" = ${jobId}::uuid
      LIMIT 1
    `;
    expect(refreshedJob?.status).toEqual("done");
    expect(refreshedJob?.attempts).toEqual(0);
    expect(refreshedJob?.last_error).toBeNull();
    expect(refreshedJob?.next_run_at).toBeNull();
  });
});
