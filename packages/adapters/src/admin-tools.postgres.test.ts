import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  adminActorFor,
  asSystem,
  createDb,
  installSecurityEventStore,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminChange, adminInfo } from "./admin-tools.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("admin tools (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `admin-org-${suffix}`;
  const spaceId = `admin-space-${suffix}`;
  const ownerId = `admin-owner-${suffix}`;
  const staffId = `admin-staff-${suffix}`;
  const email = (id: string) => `${id}@rakazo.test`;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let owner: Actor;
  const context = { botId: "bot-admin", runId: "run-admin" };
  const asOwner = <T>(fn: () => Promise<T>) => runAsTenant({ spaceId, userId: ownerId }, fn);

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    installSecurityEventStore(system);
    for (const id of [ownerId, staffId])
      await system.user.create({
        data: { id, name: id, email: email(id), emailVerified: false },
      });
    await system.organization.create({
      data: { id: organizationId, name: "Admin Co", slug: organizationId, createdAt: new Date() },
    });
    await system.space.create({
      data: { id: spaceId, organizationId, name: "Admin Co", isDefault: true },
    });
    for (const [userId, role] of [
      [ownerId, "owner"],
      [staffId, "member"],
    ] as const) {
      await system.member.create({
        data: { id: `admin-m-${userId}`, organizationId, userId, role, createdAt: new Date() },
      });
      // Joining the organization may already have added them to its default space.
      await system.spaceMember.upsert({
        where: { spaceId_userId: { spaceId, userId } },
        update: { role },
        create: {
          id: `admin-sm-${userId}`,
          spaceId,
          organizationId,
          userId,
          role,
          createdAt: new Date(),
        },
      });
    }
    owner = (await adminActorFor(prisma, { spaceId, userId: ownerId }))!;
  });

  afterAll(async () => {
    if (!prisma) return;
    installSecurityEventStore(undefined);
    await system.securityEvent.deleteMany({ where: { spaceId } });
    await system.usageRecord.deleteMany({ where: { spaceId } });
    await system.organization.deleteMany({ where: { id: organizationId } });
    await system.user.deleteMany({ where: { id: { in: [ownerId, staffId] } } });
    await close();
  });

  it("treats only owners of the space as admins", async () => {
    expect(owner).toMatchObject({ userId: ownerId, spaceId, spaceRole: "owner" });
    expect(await adminActorFor(prisma, { spaceId, userId: staffId })).toBeNull();
  });

  it("sets up a department, its people and its bot, and records each change", async () => {
    await asOwner(() =>
      adminChange(
        prisma,
        owner,
        { action: "set_persona_template", instructions: "Serve {department}." },
        context,
      ),
    );
    const created = await asOwner(() =>
      adminChange(prisma, owner, { action: "create_department", name: "Finance" }, context),
    );
    expect(created).toMatchObject({ ok: true, department: "Finance", bot: "Finance Assistant" });
    const bot = await system.bot.findFirstOrThrow({
      where: { spaceId, name: "Finance Assistant" },
      select: { id: true, instructions: true, departments: { select: { departmentId: true } } },
    });
    expect(bot.instructions).toBe("Serve Finance.");
    expect(bot.departments).toHaveLength(1);

    await asOwner(() =>
      adminChange(
        prisma,
        owner,
        { action: "set_person", department: "finance", email: email(staffId), role: "head" },
        context,
      ),
    );
    await asOwner(() =>
      adminChange(
        prisma,
        owner,
        { action: "set_bot_persona", bot: "Finance Assistant", instructions: "Be terse." },
        context,
      ),
    );
    const overview = (await asOwner(() => adminInfo(prisma, owner, { view: "overview" }))) as {
      departments: Array<{ name: string; people: unknown[]; bots: string[] }>;
      personaTemplate: string;
    };
    expect(overview.personaTemplate).toBe("Serve {department}.");
    expect(overview.departments).toEqual([
      {
        name: "Finance",
        people: [{ name: staffId, email: email(staffId), role: "head" }],
        bots: ["Finance Assistant"],
      },
    ]);
    expect((await system.bot.findUniqueOrThrow({ where: { id: bot.id } })).instructions).toBe(
      "Be terse.",
    );

    await asOwner(() =>
      adminChange(
        prisma,
        owner,
        { action: "set_person", department: "Finance", email: email(staffId), role: "none" },
        context,
      ),
    );
    expect(await system.departmentUser.count({ where: { userId: staffId } })).toBe(0);

    const audit = (await asOwner(() => adminInfo(prisma, owner, { view: "audit" }))) as {
      events: Array<{ action: string; by: string | null; via: string | null }>;
    };
    expect(audit.events.map((event) => event.action)).toEqual([
      "admin.set_person",
      "admin.set_bot_persona",
      "admin.set_person",
      "admin.create_department",
      "admin.set_persona_template",
    ]);
    expect(audit.events[0]).toMatchObject({ by: email(ownerId), via: "bot" });
  });

  it("shares a company connection with chosen departments", async () => {
    const department = await system.department.findFirstOrThrow({
      where: { spaceId, name: "Finance" },
    });
    await system.mcpServer.create({
      data: {
        spaceId,
        userId: ownerId,
        slug: "m365",
        name: "Microsoft 365",
        transport: "streamable_http",
        endpoint: "https://mcp.example.test/m365",
        shared: true,
      },
    });
    const result = await asOwner(() =>
      adminChange(
        prisma,
        owner,
        {
          action: "set_connection_departments",
          connection: "Microsoft 365",
          departments: ["Finance"],
        },
        context,
      ),
    );
    expect(result).toMatchObject({ ok: true });
    const links = await system.mcpServerDepartment.findMany({ where: { server: { spaceId } } });
    expect(links.map((link) => link.departmentId)).toEqual([department.id]);
  });

  it("leaves the deployment-wide admin switch to the deployment owner", async () => {
    const result = await asOwner(() =>
      adminChange(prisma, owner, { action: "set_admin_only", enabled: true }, context),
    );
    expect(result).toEqual({ error: "Only the deployment owner can change this." });
  });

  it("reports usage per person and per bot", async () => {
    const bot = await system.bot.findFirstOrThrow({
      where: { spaceId, name: "Finance Assistant" },
    });
    const usage = (input: { userId: string; tokens: number; cost: number }) =>
      system.usageRecord.create({
        data: {
          spaceId,
          userId: input.userId,
          botId: bot.id,
          provider: "openai",
          model: "gpt",
          totalTokens: input.tokens,
          costUsd: input.cost,
        },
      });
    await usage({ userId: ownerId, tokens: 100, cost: 0.5 });
    await usage({ userId: staffId, tokens: 300, cost: 1.5 });
    await usage({ userId: staffId, tokens: 200, cost: 1 });
    const stats = (await asOwner(() => adminInfo(prisma, owner, { view: "usage", days: 7 }))) as {
      totals: { modelCalls: number; totalTokens: number; costUsd: number };
      people: Array<{ email: string; modelCalls: number; totalTokens: number; costUsd: number }>;
      bots: Array<{ name: string; totalTokens: number }>;
    };
    expect(stats.totals).toMatchObject({ modelCalls: 3, totalTokens: 600, costUsd: 3 });
    expect(stats.people).toEqual([
      expect.objectContaining({
        email: email(staffId),
        modelCalls: 2,
        totalTokens: 500,
        costUsd: 2.5,
      }),
      expect.objectContaining({
        email: email(ownerId),
        modelCalls: 1,
        totalTokens: 100,
        costUsd: 0.5,
      }),
    ]);
    expect(stats.bots).toEqual([
      expect.objectContaining({ name: "Finance Assistant", totalTokens: 600 }),
    ]);
  });

  it("explains a request it cannot act on", async () => {
    expect(
      await asOwner(() =>
        adminChange(prisma, owner, { action: "remove_department", department: "Nope" }, context),
      ),
    ).toEqual({ error: 'No department named "Nope".' });
    expect(
      await asOwner(() => adminChange(prisma, owner, { action: "fly" }, context)),
    ).toMatchObject({ error: expect.stringContaining("action") });
  });
});
