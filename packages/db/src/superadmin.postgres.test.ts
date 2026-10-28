import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapUserSpace } from "./bootstrap-user.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { asSystem } from "./row-security.js";
import { ensureSuperadmin } from "./superadmin.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("superadmin account (PostgreSQL)", () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const env = { signupsEnabled: undefined, signupAllowlist: undefined };
  let db: PrismaClient;
  let close: () => Promise<void>;
  let previous: { ownerUserId: string | null; companySpaceId: string | null } | null = null;

  beforeAll(async () => {
    const conn = createDb(databaseUrl!);
    db = asSystem(conn.prisma);
    close = async () => {
      await conn.prisma.$disconnect();
      await conn.pool.end();
    };
    previous = await db.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { ownerUserId: true, companySpaceId: true },
    });
  });

  afterAll(async () => {
    await db.deploymentSettings.updateMany({
      where: { id: "default" },
      data: {
        ownerUserId: previous?.ownerUserId ?? null,
        companySpaceId: previous?.companySpaceId ?? null,
      },
    });
    // The company Space's rows go with its organization.
    await db.organization.deleteMany({ where: { id: `company-${stamp}` } });
    await close();
  });

  it("creates the account once and makes it the deployment owner, taking over from a person", async () => {
    const person = await db.user.create({
      data: {
        id: randomBytes(16).toString("hex"),
        email: `p-${stamp}@rakazo.test`,
        name: "P",
        emailVerified: true,
      },
    });
    await bootstrapUserSpace(db, person, env);
    await db.deploymentSettings.update({
      where: { id: "default" },
      data: { ownerUserId: person.id, companySpaceId: null },
    });
    const first = await ensureSuperadmin(db, env);
    const again = await ensureSuperadmin(db, env);
    expect(again.userId).toBe(first.userId);
    const user = await db.user.findUniqueOrThrow({ where: { id: first.userId } });
    expect(user).toMatchObject({
      email: "superadmin@botter.invalid",
      name: "Binary Elements",
      emailVerified: true,
    });
    expect(await db.account.count({ where: { userId: first.userId } })).toBe(0);
    expect(
      (await db.deploymentSettings.findUniqueOrThrow({ where: { id: "default" } })).ownerUserId,
    ).toBe(first.userId);
    expect(await db.spaceMember.count({ where: { userId: first.userId } })).toBe(1);
    expect(await db.spaceMember.count({ where: { userId: person.id } })).toBe(1);
  });

  it("signs the superadmin out everywhere and joins the company Space as an owner", async () => {
    const { userId } = await ensureSuperadmin(db, env);
    await db.session.create({
      data: {
        id: randomBytes(16).toString("hex"),
        token: randomBytes(16).toString("hex"),
        userId,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const companyId = `company-${stamp}`;
    await db.organization.create({
      data: { id: companyId, name: "Example", slug: companyId, createdAt: new Date() },
    });
    await db.space.create({
      data: { id: companyId, organizationId: companyId, name: "Example", isDefault: false },
    });
    await db.deploymentSettings.update({
      where: { id: "default" },
      data: { companySpaceId: companyId },
    });
    await ensureSuperadmin(db, env);
    expect(await db.session.count({ where: { userId } })).toBe(0);
    expect(
      await db.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: companyId, userId } },
        select: { role: true },
      }),
    ).toEqual({ role: "owner" });
  });

  it("never joins a personal Space named as the company Space", async () => {
    const person = await db.user.create({
      data: {
        id: randomBytes(16).toString("hex"),
        email: `q-${stamp}@rakazo.test`,
        name: "Q",
        emailVerified: true,
      },
    });
    await bootstrapUserSpace(db, person, env);
    const personal = await db.spaceMember.findFirstOrThrow({ where: { userId: person.id } });
    await db.deploymentSettings.update({
      where: { id: "default" },
      data: { companySpaceId: personal.spaceId },
    });
    const { userId } = await ensureSuperadmin(db, env);
    expect(await db.spaceMember.count({ where: { spaceId: personal.spaceId, userId } })).toBe(0);
  });
});
