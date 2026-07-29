
import { prisma } from "../src/client";
async function main() {
  const account = await prisma.account.create({
    data: { githubId: "demo", login: "demo", email: "demo@tern.dev" }
  });
  const installation = await prisma.installation.create({
    data: { githubId: 123456, accountId: account.id }
  });
  const repo = await prisma.repository.create({
    data: { installationId: installation.id, githubId: 123456789, owner: "tern-demo", name: "acmepay-demo", defaultBranch: "main" }
  });
  console.log(`Seeded demo repository: ${repo.owner}/${repo.name}`);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(async () => { await prisma.$disconnect(); });
