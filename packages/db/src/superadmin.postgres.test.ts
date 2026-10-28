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
  let previousOwner: string | null = null;

  beforeAll(async () => {
    const conn = createDb(databaseUrl!);
    db = asSystem(conn.prisma);
    close = async () => {
      await conn.prisma.$disconnect();
      await conn.pool.end();
    };
    previousOwner =
      (await db.deploymentSettings.findUnique({ where: { id: "default" } }))?.ownerUserId ?? null;
  });

  afterAll(async () => {
    await db.deploymentSettings.updateMany({
      where: { id: "default" },
      data: { ownerUserId: previousOwner },
    });
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
      data: { ownerUserId: person.id },
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
});
