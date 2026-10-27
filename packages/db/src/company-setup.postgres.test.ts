import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import {
  acceptInvitation,
  CompanySetupError,
  createCompanySpace,
  readCompanySetup,
  updateCompanySetup,
} from "./company-setup.js";
import { asSystem } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("company setup schema (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `setup-org-${suffix}`;
  const spaceId = `setup-space-${suffix}`;

  const userId = `setup-user-${suffix}`;
  const personalId = `setup-personal-${suffix}`;
  const inviteeId = `setup-invitee-${suffix}`;
  let system: PrismaClient;
  let saved: Awaited<ReturnType<PrismaClient["deploymentSettings"]["findUnique"]>>;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    system = asSystem(db.prisma);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await system.organization.create({
      data: { id: organizationId, name: "Setup Co", slug: organizationId, createdAt: new Date() },
    });
    await system.space.create({
      data: { id: spaceId, organizationId, name: "Setup Co", isDefault: true },
    });
    saved = await system.deploymentSettings.upsert({
      where: { id: "default" },
      update: {},
      create: { id: "default" },
    });
    await system.user.create({
      data: { id: userId, name: "Super", email: `${userId}@example.test` },
    });
    await system.organization.create({
      data: { id: personalId, name: "Personal", slug: personalId, createdAt: new Date() },
    });
    await system.member.create({
      data: {
        id: `${personalId}-m`,
        organizationId: personalId,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await system.space.create({
      data: {
        id: personalId,
        organizationId: personalId,
        name: "Personal",
        isDefault: true,
        createdByUserId: userId,
      },
    });
    await system.spaceMember.create({
      data: {
        id: `${personalId}-sm`,
        spaceId: personalId,
        organizationId: personalId,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
  });

  async function setCompanySpace(id: string | null) {
    await system.deploymentSettings.update({
      where: { id: "default" },
      data: { companySpaceId: id },
    });
  }

  afterAll(async () => {
    await system.deploymentSettings.update({
      where: { id: "default" },
      data: {
        companySpaceId: saved?.companySpaceId ?? null,
        companyOwnerEmail: saved?.companyOwnerEmail ?? null,
        companyReadyAt: saved?.companyReadyAt ?? null,
        signInMode: saved?.signInMode ?? "invited",
        companyTenantId: saved?.companyTenantId ?? null,
      },
    });
    const created = await system.space.findMany({
      where: { createdByUserId: userId, isDefault: false },
    });
    for (const space of created) {
      await system.space.delete({ where: { id: space.id } });
      await system.organization.delete({ where: { id: space.organizationId } });
    }
    await system.user.deleteMany({ where: { id: inviteeId } });
    await system.space.delete({ where: { id: personalId } });
    await system.organization.delete({ where: { id: personalId } });
    await system.user.delete({ where: { id: userId } });
    await system.space.delete({ where: { id: spaceId } });
    await system.organization.delete({ where: { id: organizationId } });
    await close();
  });

  it("stores invitations per space, one per email", async () => {
    const data = { spaceId, email: "new.hire@example.test", createdByUserId: "u1" };
    const first = await system.spaceInvitation.create({ data });
    expect(first.departments).toEqual([]);
    await expect(system.spaceInvitation.create({ data })).rejects.toMatchObject({ code: "P2002" });
    const settings = await system.deploymentSettings.upsert({
      where: { id: "default" },
      update: {},
      create: { id: "default" },
    });
    expect(settings.signInMode).toBe("invited");
  });

  it("creates a company space apart from the superadmin's own", async () => {
    await setCompanySpace(personalId);
    const { spaceId: companyId } = await createCompanySpace(system, { userId }, "Acme Test");
    expect(companyId).not.toBe(personalId);
    const personal = await system.space.findUniqueOrThrow({ where: { id: personalId } });
    expect(personal.isDefault).toBe(true);
    const company = await system.space.findUniqueOrThrow({ where: { id: companyId } });
    expect(company).toMatchObject({ name: "Acme Test", isDefault: false });
    const membership = await system.spaceMember.findUniqueOrThrow({
      where: { spaceId_userId: { spaceId: companyId, userId } },
    });
    expect(membership.role).toBe("owner");
    const orgMember = await system.member.findFirstOrThrow({
      where: { organizationId: company.organizationId, userId },
    });
    expect(orgMember.role).toBe("owner");
    const setup = await readCompanySetup(system);
    expect(setup).toMatchObject({ companySpaceId: companyId, companyName: "Acme Test" });
  });

  it("refuses a second company space", async () => {
    await expect(createCompanySpace(system, { userId }, "Other")).rejects.toMatchObject({
      code: "company-exists",
    });
    await expect(createCompanySpace(system, { userId }, "Other")).rejects.toBeInstanceOf(
      CompanySetupError,
    );
  });

  it("reads and updates setup, lower-casing the owner email", async () => {
    const readyAt = new Date();
    await updateCompanySetup(system, {
      ownerEmail: "Boss@Example.TEST",
      readyAt,
      signInMode: "organisation",
      tenantId: "tenant-1",
    });
    expect(await readCompanySetup(system)).toMatchObject({
      ownerEmail: "boss@example.test",
      readyAt,
      signInMode: "organisation",
      tenantId: "tenant-1",
    });
  });

  it("accepts an invitation once, whatever the email's case, with its departments", async () => {
    await system.user.create({
      data: { id: inviteeId, name: "Invitee", email: `${inviteeId}@example.test` },
    });
    const sales = await system.department.create({ data: { spaceId, name: "Sales" } });
    const support = await system.department.create({ data: { spaceId, name: "Support" } });
    const elsewhere = await system.department.create({ data: { spaceId: personalId, name: "X" } });
    await system.spaceInvitation.create({
      data: {
        spaceId,
        email: "invitee@example.test",
        createdByUserId: userId,
        departments: [
          { departmentId: sales.id, role: "head" },
          { departmentId: support.id, role: "member" },
          { departmentId: elsewhere.id, role: "head" },
          { departmentId: "gone", role: "member" },
        ],
      },
    });
    const accept = () =>
      acceptInvitation(system, { spaceId, email: "Invitee@Example.TEST", userId: inviteeId });
    expect(
      await acceptInvitation(system, { spaceId, email: "other@example.test", userId: inviteeId }),
    ).toBe(false);
    expect(await accept()).toBe(true);
    expect(await accept()).toBe(false);
    expect(
      await system.spaceMember.findMany({
        where: { userId: inviteeId },
        select: { spaceId: true, role: true },
      }),
    ).toEqual([{ spaceId, role: "member" }]);
    expect(
      await system.departmentUser.findMany({
        where: { userId: inviteeId },
        select: { departmentId: true, role: true },
        orderBy: { role: "asc" },
      }),
    ).toEqual([
      { departmentId: sales.id, role: "head" },
      { departmentId: support.id, role: "member" },
    ]);
    expect(
      await system.spaceInvitation.findUniqueOrThrow({
        where: { spaceId_email: { spaceId, email: "invitee@example.test" } },
        select: { acceptedUserId: true, acceptedAt: true },
      }),
    ).toMatchObject({ acceptedUserId: inviteeId, acceptedAt: expect.any(Date) });
  });
});
