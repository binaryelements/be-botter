import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { runAsSystem } from "./row-security.js";

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

/**
 * People who sign in through the company's identity provider join the company Space, when one is
 * set. Returns whether they joined.
 */
export async function joinCompanySpace(db: Db, userId: string): Promise<boolean> {
  const settings = await db.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { companySpaceId: true },
  });
  if (!settings?.companySpaceId) return false;
  await joinSpace(db, settings.companySpaceId, userId);
  return true;
}

/**
 * Set up the company connections every person signs into with their own SSO token (deployment
 * config), owned by the deployment owner and shared with the whole company. A server already at
 * that address, however an admin named or edited it, is left alone; nothing is ever removed.
 */
export async function ensureCompanySsoServers(
  db: Db,
  servers: readonly { name: string; endpoint: string }[] | undefined,
): Promise<void> {
  if (!servers?.length) return;
  const settings = await db.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { companySpaceId: true, ownerUserId: true },
  });
  if (!settings?.companySpaceId || !settings.ownerUserId) return;
  for (const server of servers) {
    const existing = await db.mcpServer.findFirst({
      where: { spaceId: settings.companySpaceId, endpoint: server.endpoint },
      select: { id: true },
    });
    if (existing) continue;
    await db.mcpServer.create({
      data: {
        spaceId: settings.companySpaceId,
        userId: settings.ownerUserId,
        slug:
          server.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "") || "sso",
        name: server.name,
        transport: "streamable_http",
        endpoint: server.endpoint,
        shared: true,
        signIn: "person",
      },
    });
  }
}

export function readConnectionsSwitch(db: Db) {
  return runAsSystem("the admin-only connections switch", () =>
    db.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { connectionsAdminOnly: true, companySpaceId: true, ownerUserId: true },
    }),
  );
}

/**
 * Whether the actor may add access (servers, tokens, secrets, accounts) and bots. While the
 * deployment's admin-only switch is on, only the deployment owner and owners of the company space
 * may, in any space they are in.
 */
export async function mayManageConnections(
  db: Db,
  actor: Pick<Actor, "userId" | "spaceId" | "isDeploymentOwner" | "spaceRole">,
): Promise<boolean> {
  if (actor.isDeploymentOwner) return true;
  const settings = await readConnectionsSwitch(db);
  if (!settings?.connectionsAdminOnly) return true;
  if (settings.ownerUserId === actor.userId) return true;
  const companySpaceId = settings.companySpaceId;
  if (!companySpaceId) return false;
  if (companySpaceId === actor.spaceId && actor.spaceRole) return actor.spaceRole === "owner";
  const membership = await runAsSystem("company space ownership", () =>
    db.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: companySpaceId, userId: actor.userId } },
      select: { role: true },
    }),
  );
  return membership?.role === "owner";
}
