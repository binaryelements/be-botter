import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { admitCompanyPerson } from "./company-admission.js";

const databaseUrl = process.env.DATABASE_URL;
const CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("admitCompanyPerson (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const spaceId = `admit-space-${suffix}`;
  const id = (name: string) => `admit-${name}-${suffix}`;
  const people = ["super", "owner", "invitee", "partner", "colleague", "stranger"].map(id);
  let system: PrismaClient;
  let close: () => Promise<void>;
  let saved: Awaited<ReturnType<PrismaClient["deploymentSettings"]["upsert"]>>;
  let headDepartmentId: string;

  const settings = (data: Parameters<PrismaClient["deploymentSettings"]["update"]>[0]["data"]) =>
    system.deploymentSettings.update({ where: { id: "default" }, data });
  const roleIn = async (userId: string) =>
    (
      await system.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId, userId } },
        select: { role: true },
      })
    )?.role ?? null;
  const admit = (
    name: string,
    email: string,
    { emailVerified = true, tenantId = null as string | null } = {},
    onDepartmentHeadsChanged?: (ids: string[]) => Promise<void>,
  ) =>
    admitCompanyPerson(
      system,
      { userId: id(name), email, emailVerified, tenantId, isDeploymentOwner: name === "super" },
      onDepartmentHeadsChanged,
    );

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    system = asSystem(db.prisma);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    for (const userId of people) {
      await system.user.create({
        data: { id: userId, name: userId, email: `${userId}@example.test` },
      });
    }
    await system.organization.create({
      data: { id: spaceId, name: "Admit Co", slug: spaceId, createdAt: new Date() },
    });
    await system.space.create({
      data: { id: spaceId, organizationId: spaceId, name: "Admit Co", isDefault: false },
    });
    const head = await system.department.create({ data: { spaceId, name: "Sales" } });
    headDepartmentId = head.id;
    await system.spaceInvitation.create({
      data: {
        spaceId,
        email: "invitee@example.test",
        createdByUserId: id("owner"),
        departments: [{ departmentId: head.id, role: "head" }],
      },
    });
    for (const email of ["super@example.test", "partner@example.test"])
      await system.spaceInvitation.create({
        data: { spaceId, email, createdByUserId: id("owner") },
      });
    saved = await system.deploymentSettings.upsert({
      where: { id: "default" },
      update: {},
      create: { id: "default" },
    });
    await settings({
      companySpaceId: spaceId,
      companyOwnerEmail: "boss@example.test",
      companyReadyAt: null,
      signInMode: "invited",
      companyTenantId: null,
    });
  });

  afterAll(async () => {
    if (!system) return;
    await settings({
      companySpaceId: saved?.companySpaceId ?? null,
      companyOwnerEmail: saved?.companyOwnerEmail ?? null,
      companyReadyAt: saved?.companyReadyAt ?? null,
      signInMode: saved?.signInMode ?? "invited",
      companyTenantId: saved?.companyTenantId ?? null,
    });
    await system.organization.deleteMany({ where: { id: spaceId } });
    await system.user.deleteMany({ where: { id: { in: people } } });
    await close();
  });

  it("leaves sites that are not handed over alone", async () => {
    expect(await admit("stranger", "stranger@example.test")).toBe("not-managed");
    expect(await roleIn(id("stranger"))).toBeNull();
    await settings({ companyReadyAt: new Date() });
  });

  it("always admits the superadmin, never as a company member, even when invited", async () => {
    expect(await admit("super", "super@example.test")).toBe("superadmin");
    expect(await admit("super", "boss@example.test", { tenantId: "tenant-a" })).toBe("superadmin");
    expect(await admit("super", "x@example.test", { emailVerified: false })).toBe("superadmin");
    expect(await roleIn(id("super"))).toBeNull();
    const invitation = await system.spaceInvitation.findUniqueOrThrow({
      where: { spaceId_email: { spaceId, email: "super@example.test" } },
    });
    expect(invitation.acceptedAt).toBeNull();
  });

  it("denies people who are neither the owner nor invited", async () => {
    expect(await admit("stranger", "stranger@example.test", { tenantId: "tenant-a" })).toBe(
      "denied",
    );
    expect(await roleIn(id("stranger"))).toBeNull();
  });

  it("makes the named owner a space owner and records their tenant", async () => {
    // Only a verified email names the owner: any tenant could carry the owner's address.
    expect(
      await admit("owner", "boss@example.test", { emailVerified: false, tenantId: "tenant-a" }),
    ).toBe("denied");
    expect(await roleIn(id("owner"))).toBeNull();
    const tenant = async () =>
      (await system.deploymentSettings.findUniqueOrThrow({ where: { id: "default" } }))
        .companyTenantId;
    // A personal Microsoft account is admitted by its verified email, but its tenant is everyone's.
    expect(await admit("owner", "boss@example.test", { tenantId: CONSUMER_TENANT })).toBe("owner");
    expect(await tenant()).toBeNull();
    expect(await admit("owner", "Boss@Example.TEST", { tenantId: "tenant-a" })).toBe("owner");
    expect(await roleIn(id("owner"))).toBe("owner");
    expect(await tenant()).toBe("tenant-a");
    await admit("owner", "boss@example.test", { tenantId: "tenant-b" });
    expect(await tenant()).toBe("tenant-a");
  });

  it("admits an invited email in any case into the space and its departments", async () => {
    const changed = vi.fn(async () => {
      throw new Error("routine sync failed");
    });
    expect(await admit("invitee", "INVITEE@example.test", {}, changed)).toBe("invited");
    expect(await roleIn(id("invitee"))).toBe("member");
    expect(changed).toHaveBeenCalledWith([headDepartmentId]);
    expect(
      await system.departmentUser.findMany({
        where: { userId: id("invitee") },
        select: { departmentId: true, role: true },
      }),
    ).toEqual([{ departmentId: headDepartmentId, role: "head" }]);
  });

  it("matches an unverified invited email only from the company's tenant", async () => {
    const unverified = { emailVerified: false };
    expect(await admit("partner", "Partner@example.test", unverified)).toBe("denied");
    expect(
      await admit("partner", "Partner@example.test", { ...unverified, tenantId: "tenant-b" }),
    ).toBe("denied");
    expect(await roleIn(id("partner"))).toBeNull();
    expect(
      await admit("partner", "Partner@example.test", { ...unverified, tenantId: "tenant-a" }),
    ).toBe("invited");
    expect(await roleIn(id("partner"))).toBe("member");
  });

  it("admits the recorded tenant only when the switch allows the organisation", async () => {
    const colleague = (tenantId: string | null) =>
      admit("colleague", "colleague@example.test", { emailVerified: false, tenantId });
    expect(await colleague("tenant-a")).toBe("denied");
    await settings({ signInMode: "organisation" });
    expect(await colleague("tenant-b")).toBe("denied");
    expect(await colleague(null)).toBe("denied");
    expect(await colleague("tenant-a")).toBe("organisation");
    expect(await roleIn(id("colleague"))).toBe("member");
  });

  it("never matches anyone on the personal-account tenant", async () => {
    await settings({ companyTenantId: CONSUMER_TENANT, signInMode: "organisation" });
    await system.spaceInvitation.create({
      data: { spaceId, email: "stranger@example.test", createdByUserId: id("owner") },
    });
    expect(
      await admit("stranger", "stranger@example.test", {
        emailVerified: false,
        tenantId: CONSUMER_TENANT,
      }),
    ).toBe("denied");
    expect(await roleIn(id("stranger"))).toBeNull();
  });
});
