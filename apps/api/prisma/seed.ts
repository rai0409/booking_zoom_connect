import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const ACTIVE_SEED_COUNT = 3;

const DEV_SALESPERSONS = [
  {
    graph_user_id: "graph-user-001",
    display_name: "Alex Doe",
    timezone: "Asia/Tokyo"
  },
  {
    graph_user_id: "graph-user-002",
    display_name: "Riley Kim",
    timezone: "Asia/Tokyo"
  },
  {
    graph_user_id: "graph-user-003",
    display_name: "Jordan Lee",
    timezone: "Asia/Tokyo"
  }
] as const;

async function main() {
  const tenant = await prisma.tenant.upsert({
    where: { slug: "acme" },
    update: {},
    create: {
      name: "Acme Corp",
      slug: "acme",
      status: "pending"
    }
  });

  const activeSeedCount = Math.max(1, Math.min(ACTIVE_SEED_COUNT, DEV_SALESPERSONS.length));
  const activeSalespersons = DEV_SALESPERSONS.slice(0, activeSeedCount);
  const inactiveGraphUserIds = DEV_SALESPERSONS.slice(activeSeedCount).map((item) => item.graph_user_id);

  for (const salesperson of activeSalespersons) {
    await prisma.salesperson.upsert({
      where: {
        tenant_id_graph_user_id: {
          tenant_id: tenant.id,
          graph_user_id: salesperson.graph_user_id
        }
      },
      update: {
        display_name: salesperson.display_name,
        timezone: salesperson.timezone,
        active: true
      },
      create: {
        tenant_id: tenant.id,
        graph_user_id: salesperson.graph_user_id,
        display_name: salesperson.display_name,
        timezone: salesperson.timezone,
        active: true
      }
    });
  }

  if (inactiveGraphUserIds.length > 0) {
    await prisma.salesperson.updateMany({
      where: {
        tenant_id: tenant.id,
        graph_user_id: { in: inactiveGraphUserIds }
      },
      data: { active: false }
    });
  }

  // Ensure dev tenant is public-enabled for public booking (runs after migrate reset)
  await prisma.tenant.updateMany({
    where: { slug: "acme" },
    data: { public_booking_enabled: true, public_timezone: "Asia/Tokyo" }
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
