import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { ensureCompanySsoServers, joinCompanySpace } from "./company-space.js";
import { asSystem } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("joinCompanySpace (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `cspace-org-${suffix}`;
  const spaceId = `cspace-space-${suffix}`;
  const ownerId = `cspace-owner-${suffix}`;
  const staffId = `cspace-staff-${suffix}`;
  const email = (id: string) => `${id}@rakazo.test`;

  let system: PrismaClient;
  let close: () => Promise<void>;
  let previousCompanySpaceId: string | null = null;
  let previousOwnerUserId: string | null = null;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    system = asSystem(db.prisma);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    for (const id of [ownerId, staffId]) {
      await system.user.create({ data: { id, name: id, email: email(id), emailVerified: false } });
    }
    await system.organization.create({
      data: { id: organizationId, name: "Company", slug: organizationId, createdAt: new Date() },
    });
    await system.space.create({
      data: { id: spaceId, organizationId, name: "Company", isDefault: true },
    });
    const settings = await system.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", ownerUserId: ownerId },
      update: {},
    });
    previousCompanySpaceId = settings.companySpaceId;
    previousOwnerUserId = settings.ownerUserId;
  });

  afterAll(async () => {
    if (!system) return;
    await system.deploymentSettings.update({
      where: { id: "default" },
      data: { companySpaceId: previousCompanySpaceId, ownerUserId: previousOwnerUserId },
    });
    await system.organization.deleteMany({ where: { id: organizationId } });
    await system.user.deleteMany({ where: { id: { in: [ownerId, staffId] } } });
    await close();
  });

  it("does nothing while no company space is set", async () => {
    await system.deploymentSettings.update({
      where: { id: "default" },
      data: { companySpaceId: null },
    });
    expect(await joinCompanySpace(system, staffId)).toBe(false);
    expect(await system.spaceMember.count({ where: { userId: staffId } })).toBe(0);
  });

  it("makes a new person a member of the company space and its organization, once", async () => {
    await system.deploymentSettings.update({
      where: { id: "default" },
      data: { companySpaceId: spaceId },
    });
    expect(await joinCompanySpace(system, staffId)).toBe(true);
    await joinCompanySpace(system, staffId);
    expect(
      await system.spaceMember.findMany({
        where: { userId: staffId },
        select: { spaceId: true, role: true },
      }),
    ).toEqual([{ spaceId, role: "member" }]);
    expect(
      await system.member.findMany({
        where: { userId: staffId },
        select: { organizationId: true, role: true },
      }),
    ).toEqual([{ organizationId, role: "member" }]);
  });

  describe("ensureCompanySsoServers", () => {
    const m365 = { name: "Microsoft 365", endpoint: "http://ms365:3000/mcp" };
    const servers = () =>
      system.mcpServer.findMany({
        where: { spaceId },
        select: { name: true, endpoint: true, userId: true, shared: true, signIn: true },
        orderBy: { name: "asc" },
      });

    it("waits for a company space", async () => {
      await system.deploymentSettings.update({
        where: { id: "default" },
        data: { companySpaceId: null, ownerUserId: ownerId },
      });
      await ensureCompanySsoServers(system, [m365]);
      expect(await servers()).toEqual([]);
    });

    it("sets up each missing server once, shared and signed in as each person", async () => {
      await system.deploymentSettings.update({
        where: { id: "default" },
        data: { companySpaceId: spaceId, ownerUserId: ownerId },
      });
      await ensureCompanySsoServers(system, [m365]);
      await ensureCompanySsoServers(system, [m365]);
      expect(await servers()).toEqual([
        { ...m365, userId: ownerId, shared: true, signIn: "person" },
      ]);
    });

    it("leaves a server an admin already added at that address alone", async () => {
      await system.mcpServer.deleteMany({ where: { spaceId } });
      await system.mcpServer.create({
        data: {
          spaceId,
          userId: staffId,
          slug: "mso365",
          name: "Mso365",
          transport: "streamable_http",
          endpoint: m365.endpoint,
          shared: true,
          signIn: "person",
        },
      });
      await ensureCompanySsoServers(system, [m365]);
      expect(await servers()).toEqual([
        {
          name: "Mso365",
          endpoint: m365.endpoint,
          userId: staffId,
          shared: true,
          signIn: "person",
        },
      ]);
    });
  });
});
