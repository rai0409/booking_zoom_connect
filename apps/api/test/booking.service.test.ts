import { BookingService } from "../src/services/booking.service";
import { prisma } from "../src/prisma";
import { DateTime } from "luxon";
import { BookingStatus } from "@prisma/client";

const service = new BookingService();

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

describe("BookingService", () => {
  beforeAll(async () => {
    await resetDb();
    await prisma.tenant.create({
      data: { name: "Acme", slug: "acme", status: "active" }
    });
    const tenant = await prisma.tenant.findUnique({ where: { slug: "acme" } });
    await prisma.salesperson.create({
      data: {
        tenant_id: tenant!.id,
        graph_user_id: "graph-user-001",
        display_name: "Alex",
        timezone: "Asia/Tokyo",
        active: true
      }
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test("hold idempotency and slot conflict", async () => {
    const tenant = await prisma.tenant.findUnique({ where: { slug: "acme" } });
    const salesperson = await prisma.salesperson.findFirst({ where: { tenant_id: tenant!.id } });
    const start = DateTime.utc().plus({ hours: 2 }).toISO();
    const end = DateTime.utc().plus({ hours: 3 }).toISO();

    const first = await service.createHold(
      "acme",
      {
        salesperson_id: salesperson!.id,
        start_at: start!,
        end_at: end!,
        customer: { email: "test@example.com" }
      },
      "idem-1"
    );

    const second = await service.createHold(
      "acme",
      {
        salesperson_id: salesperson!.id,
        start_at: start!,
        end_at: end!,
        customer: { email: "test@example.com" }
      },
      "idem-1"
    );

    expect(second.id).toEqual(first.id);

    await expect(
      service.createHold(
        "acme",
        {
          salesperson_id: salesperson!.id,
          start_at: start!,
          end_at: end!,
          customer: { email: "test2@example.com" }
        },
        "idem-2"
      )
    ).rejects.toThrow();
  });

  test("confirm saga happy path and graph failure compensation", async () => {
    const tenant = await prisma.tenant.findUnique({ where: { slug: "acme" } });
    const salesperson = await prisma.salesperson.findFirst({ where: { tenant_id: tenant!.id } });
    const start = DateTime.utc().plus({ hours: 4 }).toISO();
    const end = DateTime.utc().plus({ hours: 5 }).toISO();

    const booking = await service.createHold(
      "acme",
      {
        salesperson_id: salesperson!.id,
        start_at: start!,
        end_at: end!,
        customer: { email: "flow@example.com" }
      },
      "idem-3"
    );

    const verify = await service.sendVerification("acme", booking.id, "idem-verify");
    const confirmed = await service.confirmBooking("acme", verify.token, "idem-confirm");

    const refreshed = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(refreshed?.status).toEqual(BookingStatus.confirmed);
    expect(confirmed?.status).toEqual(BookingStatus.confirmed);

    const booking2 = await service.createHold(
      "acme",
      {
        salesperson_id: salesperson!.id,
        start_at: DateTime.utc().plus({ hours: 6 }).toISO()!,
        end_at: DateTime.utc().plus({ hours: 7 }).toISO()!,
        customer: { email: "fail@example.com" }
      },
      "idem-4"
    );

    const verify2 = await service.sendVerification("acme", booking2.id, "idem-verify-2");

    (service as any).graph = {
      createEvent: async () => {
        throw new Error("graph down");
      },
      sendMail: async () => {},
      deleteEvent: async () => {}
    };
    (service as any).zoom = {
      createMeeting: async () => ({ meetingId: "m1", joinUrl: "j1", startUrl: "s1" }),
      deleteMeeting: async () => {}
    };

    await expect(service.confirmBooking("acme", verify2.token, "idem-confirm-2")).rejects.toThrow();

    const compensation = await prisma.compensationJob.findFirst({
      where: { booking_id: booking2.id, tenant_id: tenant!.id }
    });
    expect(compensation).toBeTruthy();
  });
});
