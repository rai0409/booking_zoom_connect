import { BookingService } from "../src/services/booking.service";
import { prisma } from "../src/prisma";
import { DateTime } from "luxon";
import { BookingStatus } from "@prisma/client";

const service = new BookingService();
(service as any).graph = { getBusySlots: async () => [] };
const ORIGINAL_GRAPH_ENABLED = process.env.GRAPH_ENABLED;

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
    await prisma.salesperson.create({
      data: {
        tenant_id: tenant!.id,
        graph_user_id: "graph-user-002",
        display_name: "Bob",
        timezone: "Asia/Tokyo",
        active: true
      }
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    if (ORIGINAL_GRAPH_ENABLED === undefined) {
      delete process.env.GRAPH_ENABLED;
    } else {
      process.env.GRAPH_ENABLED = ORIGINAL_GRAPH_ENABLED;
    }
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

    process.env.GRAPH_ENABLED = "1";
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
    expect(verify.token).toBeTruthy();
    const confirmed = await service.confirmBooking("acme", verify.token!, "idem-confirm");

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

    await prisma.tenant.update({
      where: { id: tenant!.id },
      data: { m365_tenant_id: tenant!.m365_tenant_id ?? "mock-m365-tenant" },
    });
    expect(salesperson).toBeTruthy();
    const createEvent = jest.fn(async (..._args: any[]) => { throw new Error("graph down"); });
    const sendMail = jest.fn(async (..._args: any[]) => {});
    const deleteEvent = jest.fn(async (..._args: any[]) => {});
(service as any).graph = { ...(service as any).graph, createEvent, sendMail, deleteEvent, getBusySlots: async () => [] };
    const createMeeting = jest.fn(async () => ({ meetingId: "m1", joinUrl: "j1", startUrl: "s1" }));
    const deleteMeeting = jest.fn(async (..._args: any[]) => {});
    (service as any).zoom = { createMeeting, deleteMeeting };

    const confirmed2 = await service.confirmBooking("acme", verify2.token!, "idem-confirm-2");
    expect(confirmed2?.status).toEqual(BookingStatus.confirmed);
    const refreshed2 = await prisma.booking.findUnique({ where: { id: booking2.id } });
    expect(refreshed2?.status).toEqual(BookingStatus.confirmed);

    expect(createEvent).toHaveBeenCalled();

    const compensation = await prisma.compensationJob.findFirst({
      where: { booking_id: booking2.id, tenant_id: tenant!.id }
    });
    expect(compensation).toBeNull();
  });

  test("createHold supports round-robin assignment when salesperson_id is omitted", async () => {
    const tenant = await prisma.tenant.findUnique({ where: { slug: "acme" } });
    expect(tenant).toBeTruthy();
    await prisma.tenant.update({
   where: { id: tenant!.id },
   data: { rr_cursor: 0 },
 });

    const salespersons = await prisma.salesperson.findMany({
      where: { tenant_id: tenant!.id, active: true },
      orderBy: { display_name: "asc" }
    });
    expect(salespersons.length).toBeGreaterThanOrEqual(2);

    const first = await service.createHold(
      "acme",
      {
        start_at: DateTime.utc().plus({ hours: 26 }).toISO()!,
        end_at: DateTime.utc().plus({ hours: 27 }).toISO()!,
        booking_mode: "online",
        public_notes: "RR note one",
        customer: { email: "rr1@example.com", name: "RR One" }
      },
      "rr-idem-1"
    );
    const second = await service.createHold(
      "acme",
      {
        start_at: DateTime.utc().plus({ hours: 28 }).toISO()!,
        end_at: DateTime.utc().plus({ hours: 29 }).toISO()!,
        booking_mode: "offline",
        public_notes: "RR note two",
        customer: { email: "rr2@example.com", name: "RR Two" }
      },
      "rr-idem-2"
    );

    expect(first.salesperson_id).toEqual(salespersons[0].id);
    expect(second.salesperson_id).toEqual(salespersons[1].id);
    const firstFields = await prisma.booking.findUnique({
      where: { id: first.id },
      select: { booking_mode: true, public_notes: true },
    });
    const secondFields = await prisma.booking.findUnique({
      where: { id: second.id },
      select: { booking_mode: true, public_notes: true },
    });
    expect(firstFields?.booking_mode).toEqual("online");
    expect(secondFields?.booking_mode).toEqual("offline");
    expect(firstFields?.public_notes).toEqual("RR note one");
    expect(secondFields?.public_notes).toEqual("RR note two");

    const refreshedTenant = await prisma.tenant.findUnique({
      where: { id: tenant!.id },
      select: { rr_cursor: true },
    });
    expect(refreshedTenant?.rr_cursor).toEqual(0);
  });

  test("createHold keeps rr_cursor when all salespersons are busy", async () => {
    const tenant = await prisma.tenant.findUnique({ where: { slug: "acme" } });
    expect(tenant).toBeTruthy();
    await prisma.tenant.update({
   where: { id: tenant!.id },
   data: { rr_cursor: 0 },
 });

    const salespersons = await prisma.salesperson.findMany({
      where: { tenant_id: tenant!.id, active: true },
      orderBy: { display_name: "asc" }
    });
    const start = DateTime.utc().plus({ hours: 60 }).toJSDate();
    const end = DateTime.utc().plus({ hours: 61 }).toJSDate();

    const customer = await prisma.customer.upsert({
      where: { tenant_id_email: { tenant_id: tenant!.id, email: "busy@example.com" } },
      update: {},
      create: { tenant_id: tenant!.id, email: "busy@example.com" }
    });

    for (let i = 0; i < salespersons.length; i += 1) {
      await prisma.booking.create({
        data: {
          tenant_id: tenant!.id,
          salesperson_id: salespersons[i].id,
          customer_id: customer.id,
          start_at_utc: start,
          end_at_utc: end,
          status: BookingStatus.confirmed,
          idempotency_key: `busy-slot-${i}-${Date.now()}`
        }
      });
    }

    await expect(
      service.createHold(
        "acme",
        {
          start_at: DateTime.fromJSDate(start, { zone: "utc" }).toISO()!,
          end_at: DateTime.fromJSDate(end, { zone: "utc" }).toISO()!,
          booking_mode: "online",
          customer: { email: "newbusy@example.com", name: "Busy User" }
        },
        "rr-busy-idem"
      )
    ).rejects.toThrow();

    const refreshedTenant = await prisma.tenant.findUnique({
      where: { id: tenant!.id },
      select: { rr_cursor: true },
    });
    expect(refreshedTenant?.rr_cursor).toEqual(0);
  });

  test("availability union returns slots where at least one salesperson is free", async () => {
    const tenant = await prisma.tenant.findUnique({ where: { slug: "acme" } });
    expect(tenant).toBeTruthy();

    await prisma.tenant.update({
      where: { id: tenant!.id },
      data: {
        public_timezone: "UTC",
        public_business_hours: {
          slot_minutes: 60,
          lead_time_minutes: 0,
          buffer_minutes: 0,
          max_days_ahead: 30,
          weekly: {
            mon: { open: "09:00", close: "11:00", breaks: [] },
            tue: { open: "09:00", close: "11:00", breaks: [] },
            wed: { open: "09:00", close: "11:00", breaks: [] },
            thu: { open: "09:00", close: "11:00", breaks: [] },
            fri: { open: "09:00", close: "11:00", breaks: [] },
            sat: { open: "09:00", close: "11:00", breaks: [] },
            sun: { open: "09:00", close: "11:00", breaks: [] }
          }
        }
      }
    });

    const salespersons = await prisma.salesperson.findMany({
      where: { tenant_id: tenant!.id, active: true },
      orderBy: { display_name: "asc" }
    });
    const date = DateTime.utc().plus({ days: 2 }).toFormat("yyyy-LL-dd");
    const slot1Start = DateTime.fromISO(`${date}T09:00:00`, { zone: "utc" }).toJSDate();
    const slot1End = DateTime.fromISO(`${date}T10:00:00`, { zone: "utc" }).toJSDate();
    const slot2Start = DateTime.fromISO(`${date}T10:00:00`, { zone: "utc" }).toJSDate();
    const slot2End = DateTime.fromISO(`${date}T11:00:00`, { zone: "utc" }).toJSDate();

    const customerA = await prisma.customer.upsert({
      where: { tenant_id_email: { tenant_id: tenant!.id, email: "union-a@example.com" } },
      update: {},
      create: { tenant_id: tenant!.id, email: "union-a@example.com" }
    });
    const customerB = await prisma.customer.upsert({
      where: { tenant_id_email: { tenant_id: tenant!.id, email: "union-b@example.com" } },
      update: {},
      create: { tenant_id: tenant!.id, email: "union-b@example.com" }
    });

    await prisma.booking.create({
      data: {
        tenant_id: tenant!.id,
        salesperson_id: salespersons[0].id,
        customer_id: customerA.id,
        start_at_utc: slot1Start,
        end_at_utc: slot1End,
        status: BookingStatus.confirmed,
        idempotency_key: `union-1-${Date.now()}`
      }
    });
    await prisma.booking.create({
      data: {
        tenant_id: tenant!.id,
        salesperson_id: salespersons[1].id,
        customer_id: customerB.id,
        start_at_utc: slot2Start,
        end_at_utc: slot2End,
        status: BookingStatus.confirmed,
        idempotency_key: `union-2-${Date.now()}`
      }
    });

    (service as any).availabilityCache.clear();
    const union = await service.getAvailability("acme", undefined, date);
    expect(union.some((s) => s.start_at_utc === DateTime.fromJSDate(slot1Start, { zone: "utc" }).toISO())).toBeTruthy();
    expect(union.some((s) => s.start_at_utc === DateTime.fromJSDate(slot2Start, { zone: "utc" }).toISO())).toBeTruthy();
  });
});
