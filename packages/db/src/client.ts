
import { PrismaClient } from "../prisma/client";
import { getConfig } from "@tern/shared";

const globalForPrisma = global as unknown as { prisma?: PrismaClient };
export const prisma = globalForPrisma.prisma || new PrismaClient({
  log: getConfig().NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"]
});
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

process.on("beforeExit", async () => { await prisma.$disconnect(); });
