import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** Make a person a member of a Space and of its organization; already a member means no change. */
export async function joinSpace(db: Db, spaceId: string, userId: string): Promise<void> {
  const space = await db.space.findUniqueOrThrow({
    where: { id: spaceId },
    select: { organizationId: true },
  });
  const now = new Date();
  await db.member.upsert({
    where: { organizationId_userId: { organizationId: space.organizationId, userId } },
    update: {},
    create: {
      id: randomUUID(),
      organizationId: space.organizationId,
      userId,
      role: "member",
      createdAt: now,
    },
  });
  await db.spaceMember.upsert({
    where: { spaceId_userId: { spaceId, userId } },
    update: {},
    create: {
      id: randomUUID(),
      spaceId,
      organizationId: space.organizationId,
      userId,
      role: "member",
      createdAt: now,
    },
  });
}

/** People who sign in through the company's identity provider join the company Space, when one is set. */
export async function joinCompanySpace(db: Db, userId: string): Promise<void> {
  const settings = await db.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { companySpaceId: true },
  });
  if (settings?.companySpaceId) await joinSpace(db, settings.companySpaceId, userId);
}
