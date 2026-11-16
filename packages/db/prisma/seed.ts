/**
 * Development seed.
 *
 * Creates the minimum rows needed to exercise the pipeline locally: one user, one
 * installation and one repository. It is idempotent, so it can be re-run safely.
 *
 * It never creates credentials, tokens or secrets of any kind.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const user = await prisma.user.upsert({
    where: { githubId: "demo-user" },
    create: { githubId: "demo-user", login: "tern-demo", name: "Tern Demo", email: "demo@tern.invalid" },
    update: {}
  });

  const installation = await prisma.installation.upsert({
    where: { githubId: 1 },
    create: { githubId: 1, accountLogin: "tern-demo", accountType: "Organization", ownerId: user.id },
    update: { ownerId: user.id }
  });

  const repository = await prisma.repository.upsert({
    where: { githubId: 1 },
    create: {
      githubId: 1,
      installationId: installation.id,
      owner: "tern-demo",
      name: "acmepay-demo",
      defaultBranch: "main",
      isPrivate: false
    },
    update: { installationId: installation.id }
  });

  console.log(`Seeded ${repository.owner}/${repository.name} (installation ${installation.githubId})`);
}

main()
  .catch((error) => {
    console.error("Seed failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
