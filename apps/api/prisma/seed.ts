import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

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

  await prisma.salesperson.createMany({
    data: [
      {
        tenant_id: tenant.id,
        graph_user_id: "graph-user-001",
        display_name: "Alex Doe",
        timezone: "Asia/Tokyo",
        active: true
      },
      {
        tenant_id: tenant.id,
        graph_user_id: "graph-user-002",
        display_name: "Riley Kim",
        timezone: "Asia/Tokyo",
        active: true
      }
    ],
    skipDuplicates: true
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
