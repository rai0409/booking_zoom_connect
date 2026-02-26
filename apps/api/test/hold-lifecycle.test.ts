import { BookingService } from "../src/services/booking.service";
import { prisma } from "../src/prisma";
import { ConflictException } from "@nestjs/common";

const svc = new BookingService();
(svc as any).graph = { getBusySlots: async () => [] };

const ORIGINAL_GRAPH_ENABLED = process.env.GRAPH_ENABLED;

async function resetDb() {
  // 外部キーに強い：子→親を意識せずに掃除できる
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
async function seedTenantAndSalesperson() {
  const tenant = await prisma.tenant.create({
    data: {
      slug: `t-${Date.now()}`,
      name: "Test Tenant",
      public_booking_enabled: true,
      // 任意：テストの安定化（デフォルトでもOK）
      public_timezone: "Asia/Tokyo",
      status: "active"
    }
  });

  // salesperson が必須な実装が多いので最低1件作る（スキーマに合わせて必要項目は調整）
  const salesperson = await prisma.salesperson.create({
    data: {
      tenant_id: tenant.id,
      display_name: "Alice",
      timezone: "Asia/Tokyo",
      graph_user_id: "graph-user-001",
      active: true
    }
  });

  return { tenant, salesperson };
}

describe("hold lifecycle invariants", () => {
  beforeAll(async () => {
    process.env.GRAPH_ENABLED = "0";
    await resetDb();
  });

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {

    await prisma.$disconnect();
    if (ORIGINAL_GRAPH_ENABLED === undefined) delete process.env.GRAPH_ENABLED;
    else process.env.GRAPH_ENABLED = ORIGINAL_GRAPH_ENABLED;
  });

  test("confirm removes hold (no hold residue after confirm)", async () => {
    const { tenant, salesperson } = await seedTenantAndSalesperson();

    const start = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const end = new Date(Date.now() + 90 * 60 * 1000).toISOString();

    const holdPayload: any = {
      salesperson_id: salesperson?.id, // 実装により必須
      start_at: start,
      end_at: end,
      booking_mode: "offline",
      public_notes: "test",
      customer: { email: "a@example.com", name: "A", company: "C" }
    };

    const idemHold = `idem-hold-${Date.now()}`;
    const resHold = await svc.createHoldPublic(tenant.slug, holdPayload, idemHold);
    const bookingId = resHold.id;

    const verify = await (svc as any).sendVerification?.(tenant.slug, bookingId, `idem-verify-${Date.now()}`);
    expect(verify?.token).toBeTruthy();

    await svc.confirmBookingPublic(
      tenant.slug,
      verify.token,
      `idem-confirm-${Date.now()}`
    );
    const holdCount = await prisma.hold.count({ where: { booking_id: bookingId } });
    expect(holdCount).toBe(0);
  });

  test("expireHolds removes expired holds and updates booking status", async () => {
    const { tenant, salesperson } = await seedTenantAndSalesperson();

    const start = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const end = new Date(Date.now() + 90 * 60 * 1000).toISOString();

    const holdPayload: any = {
      salesperson_id: salesperson?.id,
      start_at: start,
      end_at: end,
      booking_mode: "offline",
      customer: { email: "b@example.com", name: "B" }
    };

    const idemHold = `idem-hold-${Date.now()}`;
    const resHold = await svc.createHoldPublic(tenant.slug, holdPayload, idemHold);
    const bookingId = resHold.id;

    // hold を過去にして期限切れへ
    await prisma.hold.updateMany({
      where: { booking_id: bookingId },
      data: { expires_at_utc: new Date(Date.now() - 60 * 1000) } // 1分前
    });

    const r = await svc.expireHolds();

    const holdCount = await prisma.hold.count({ where: { booking_id: bookingId } });
    expect(holdCount).toBe(0);

    // status は実装に依存するので「hold/pending_verify 以外」を期待にするのが安全
    const booking = await prisma.booking.findUnique({ where: { id: bookingId }, select: { status: true } });
    expect(booking?.status).not.toBe("hold");
    expect(booking?.status).not.toBe("pending_verify");

    // 返却値も最低限チェック
    expect(r.deletedHolds).toBeGreaterThanOrEqual(1);
  });

  test("slot conflict returns 409 (Conflict) and does not create extra holds", async () => {
    const { tenant, salesperson } = await seedTenantAndSalesperson();

    const start = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const end = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();

    const payload: any = {
      salesperson_id: salesperson?.id,
      start_at: start,
      end_at: end,
      booking_mode: "offline",
      customer: { email: "c@example.com", name: "C" }
    };

    const r1 = await svc.createHoldPublic(tenant.slug, payload, `idem-1-${Date.now()}`);
    const holdsBefore = await prisma.hold.count({});

    let threw = false;
    try {
      await svc.createHoldPublic(tenant.slug, payload, `idem-2-${Date.now()}`);
    } catch (e) {
      threw = true;
      // nest の例外型に寄せる（実装が ConflictException を投げている想定）
      expect(e instanceof ConflictException).toBe(true);
    }
    expect(threw).toBe(true);

    const holdsAfter = await prisma.hold.count({});
    expect(holdsAfter).toBe(holdsBefore);

    // 既存の hold が残っていること（1回目の分）
    const holdCountForFirst = await prisma.hold.count({ where: { booking_id: r1.id } });
    expect(holdCountForFirst).toBeGreaterThanOrEqual(1);
  });
});
