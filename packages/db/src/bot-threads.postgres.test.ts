import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { channelThread, homeThread, privateThread } from "./bot-threads.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { asSystem } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("bot threads (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `bthr-org-${suffix}`;
  const spaceId = `bthr-space-${suffix}`;
  const ownerId = `bthr-owner-${suffix}`;
  const staffId = `bthr-staff-${suffix}`;
  const email = (id: string) => `${id}@rakazo.test`;

  let system: PrismaClient;
  let close: () => Promise<void>;
  let bot: { id: string; spaceId: string; userId: string; homeThreadId: string | null };
  let departmentId: string;

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
      data: {
        id: organizationId,
        name: "Bot threads",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    await system.space.create({
      data: { id: spaceId, organizationId, name: "Bot threads", isDefault: true },
    });
    bot = await system.bot.create({
      data: { spaceId, userId: ownerId, name: "IT Support", color: "#3B82F6" },
    });
    departmentId = (await system.department.create({ data: { spaceId, name: "IT" } })).id;
  });

  afterAll(async () => {
    if (!system) return;
    await system.organization.deleteMany({ where: { id: organizationId } });
    await system.user.deleteMany({ where: { id: { in: [ownerId, staffId] } } });
    await close();
  });

  it("creates a person's private thread once and returns it afterwards", async () => {
    const first = await privateThread(system, bot, staffId);
    const again = await privateThread(system, bot, staffId);
    expect(again.id).toBe(first.id);
    const row = await system.thread.findUniqueOrThrow({ where: { id: first.id } });
    expect(row).toMatchObject({ botId: bot.id, userId: staffId, departmentId: null, spaceId });
  });

  it("heals a bot without a home thread and remembers it", async () => {
    const home = await homeThread(system, bot);
    const stored = await system.bot.findUniqueOrThrow({ where: { id: bot.id } });
    expect(stored.homeThreadId).toBe(home.id);
    expect(await privateThread(system, bot, ownerId)).toEqual({ id: home.id });
    expect(await homeThread(system, stored)).toEqual({ id: home.id });
    expect(await system.thread.count({ where: { botId: bot.id } })).toBe(2);
  });

  it("creates a department's channel once per bot", async () => {
    const first = await channelThread(system, bot, departmentId, staffId);
    const again = await channelThread(system, bot, departmentId, ownerId);
    expect(again.id).toBe(first.id);
    const row = await system.thread.findUniqueOrThrow({ where: { id: first.id } });
    expect(row).toMatchObject({ botId: bot.id, departmentId, userId: staffId });
    expect(await system.thread.count({ where: { botId: bot.id } })).toBe(3);
  });
});
