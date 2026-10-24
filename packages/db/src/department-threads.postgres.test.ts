import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { asSystem } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("department threads (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `dthr-org-${suffix}`;
  const spaceId = `dthr-space-${suffix}`;
  const ownerId = `dthr-owner-${suffix}`;
  const staffId = `dthr-staff-${suffix}`;
  const email = (id: string) => `${id}@rakazo.test`;

  let system: PrismaClient;
  let close: () => Promise<void>;
  let botId: string;
  let itDepartmentId: string;
  let salesDepartmentId: string;

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
      data: { id: organizationId, name: "Threads Co", slug: organizationId, createdAt: new Date() },
    });
    await system.space.create({
      data: { id: spaceId, organizationId, name: "Threads Co", isDefault: true },
    });
    const bot = await system.bot.create({
      data: { spaceId, userId: ownerId, name: "IT Support", color: "#3B82F6" },
    });
    botId = bot.id;
    const it = await system.department.create({ data: { spaceId, name: "IT" } });
    const sales = await system.department.create({ data: { spaceId, name: "Sales" } });
    itDepartmentId = it.id;
    salesDepartmentId = sales.id;
  });

  afterAll(async () => {
    if (!system) return;
    await system.organization.deleteMany({ where: { id: organizationId } });
    await system.user.deleteMany({ where: { id: { in: [ownerId, staffId] } } });
    await close();
  });

  it("gives each person one private thread per bot", async () => {
    await system.thread.create({ data: { spaceId, userId: ownerId, botId } });
    await system.thread.create({ data: { spaceId, userId: staffId, botId } });
    await expect(
      system.thread.create({ data: { spaceId, userId: staffId, botId } }),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(await system.thread.count({ where: { botId, departmentId: null } })).toBe(2);
  });

  it("gives each department one channel per bot", async () => {
    await system.thread.create({
      data: { spaceId, userId: ownerId, botId, departmentId: itDepartmentId },
    });
    await system.thread.create({
      data: { spaceId, userId: staffId, botId, departmentId: salesDepartmentId },
    });
    await expect(
      system.thread.create({
        data: { spaceId, userId: staffId, botId, departmentId: itDepartmentId },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(await system.thread.count({ where: { botId } })).toBe(4);
  });

  it("deletes a department's channels with the department", async () => {
    await system.department.delete({ where: { id: salesDepartmentId } });
    expect(await system.thread.count({ where: { botId } })).toBe(3);
    expect(await system.thread.count({ where: { botId, departmentId: itDepartmentId } })).toBe(1);
  });

  it("keeps one read row per person and thread", async () => {
    const channel = await system.thread.findFirstOrThrow({
      where: { botId, departmentId: itDepartmentId },
    });
    await system.threadRead.create({
      data: { threadId: channel.id, userId: staffId, lastReadSeq: 3 },
    });
    await expect(
      system.threadRead.create({ data: { threadId: channel.id, userId: staffId } }),
    ).rejects.toMatchObject({ code: "P2002" });
    await system.thread.delete({ where: { id: channel.id } });
    expect(await system.threadRead.count({ where: { threadId: channel.id } })).toBe(0);
  });

  it("points a bot at its home thread and lets go when that thread is deleted", async () => {
    const home = await system.thread.findFirstOrThrow({
      where: { botId, userId: ownerId, departmentId: null },
    });
    await system.bot.update({ where: { id: botId }, data: { homeThreadId: home.id } });
    const other = await system.bot.create({
      data: { spaceId, userId: ownerId, name: "Chief", color: "#F5A03C" },
    });
    await expect(
      system.bot.update({ where: { id: other.id }, data: { homeThreadId: home.id } }),
    ).rejects.toMatchObject({ code: "P2002" });
    await system.thread.delete({ where: { id: home.id } });
    const bot = await system.bot.findUniqueOrThrow({ where: { id: botId } });
    expect(bot.homeThreadId).toBeNull();
  });
});
