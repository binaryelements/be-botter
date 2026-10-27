import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioConnector, FakeComposioClient } from "@rakazo/adapters";
import { asSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { createApp } from "./app.js";
import type { departmentBotIds } from "./department-routines.js";

type AppHandles = Awaited<ReturnType<typeof createApp>>;

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("department routines run as the head (PostgreSQL)", () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-dept-routines-"));
  let handles: AppHandles;
  let db: AppHandles["prisma"];
  let sync: typeof import("./department-routines.js");
  const queued: string[] = [];
  const jobs = {
    enqueue: async (job: { name?: string; payload?: unknown }) =>
      void queued.push(JSON.stringify(job)),
  };
  const ids = {
    owner: `dr-owner-${stamp}`,
    a: `dr-a-${stamp}`,
    b: `dr-b-${stamp}`,
    plain: `dr-plain-${stamp}`,
  };
  let spaceId: string;
  let departmentId: string;
  let botId: string;
  let routineId: string;
  const deps = () =>
    ({ prisma: handles.prisma, jobs }) as never as Parameters<typeof departmentBotIds>[0];

  const addHead = async (userId: string, offsetMs: number, token: boolean) => {
    await db.departmentUser.create({
      data: { departmentId, userId, role: "head", createdAt: new Date(Date.now() + offsetMs) },
    });
    if (token) {
      await db.secret.create({
        data: { userId, spaceId: null, kind: "sso-token", ciphertext: "x" },
      });
    }
  };
  const routine = () => db.routine.findUniqueOrThrow({ where: { id: routineId } });

  beforeAll(async () => {
    const { createApp } = await import("./app.js");
    handles = await createApp({
      databaseUrl: databaseUrl!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      composio: new ComposioConnector({ client: new FakeComposioClient() }),
    });
    db = asSystem(handles.prisma);
    sync = await import("./department-routines.js");
    for (const id of Object.values(ids)) {
      await db.user.create({
        data: { id, name: id, email: `${id}@rakazo.test`, emailVerified: true },
      });
    }
    const org = await db.organization.create({
      data: { id: `dr-org-${stamp}`, name: "Org", slug: `dr-org-${stamp}`, createdAt: new Date() },
    });
    spaceId = (
      await db.space.create({
        data: { id: `dr-space-${stamp}`, organizationId: org.id, name: "Co" },
      })
    ).id;
    botId = (
      await db.bot.create({
        data: { spaceId, userId: ids.owner, name: "Accounts", color: "#3B82F6" },
      })
    ).id;
    departmentId = (await db.department.create({ data: { spaceId, name: "Accounts" } })).id;
    await db.departmentBot.create({ data: { departmentId, botId } });
    routineId = (
      await db.routine.create({
        data: {
          spaceId,
          botId,
          userId: ids.owner,
          name: "Weekly",
          prompt: "x",
          crons: ["0 9 * * 1"],
          timezone: "UTC",
          runsAsDepartmentHead: true,
          waitingForHead: true,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await db?.space.deleteMany({ where: { id: spaceId } });
    await db?.organization.deleteMany({ where: { id: `dr-org-${stamp}` } });
    await db?.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("keeps routines off and with the bot owner when there is no head", async () => {
    await sync.syncDepartmentRoutines(deps(), departmentId);
    expect(await routine()).toMatchObject({
      userId: ids.owner,
      threadId: null,
      personCreated: false,
      active: false,
      nextRunAt: null,
    });
    expect(queued).toHaveLength(0);
  });

  it("treats a head without a stored token as no head", async () => {
    await addHead(ids.a, 0, false);
    await sync.syncDepartmentRoutines(deps(), departmentId);
    expect((await routine()).active).toBe(false);
  });

  it("runs as a head with a token, in their private thread, and queues a wakeup once", async () => {
    await db.secret.create({
      data: { userId: ids.a, spaceId: null, kind: "sso-token", ciphertext: "x" },
    });
    await sync.syncDepartmentRoutines(deps(), departmentId);
    const thread = await db.thread.findFirstOrThrow({
      where: { botId, userId: ids.a, departmentId: null },
    });
    const row = await routine();
    expect(row).toMatchObject({
      userId: ids.a,
      threadId: thread.id,
      personCreated: true,
      active: true,
    });
    expect(row.nextRunAt).toBeInstanceOf(Date);
    expect(queued).toHaveLength(1);
    await sync.syncDepartmentRoutines(deps(), departmentId);
    expect((await routine()).nextRunAt).toEqual(row.nextRunAt);
    expect(queued).toHaveLength(1);
  });

  it("lets the earliest head win and hands over when they leave", async () => {
    await addHead(ids.b, 1000, true);
    await sync.syncDepartmentRoutines(deps(), departmentId);
    expect((await routine()).userId).toBe(ids.a);
    await db.departmentUser.deleteMany({ where: { departmentId, userId: ids.a } });
    await sync.syncDepartmentRoutines(deps(), departmentId);
    const row = await routine();
    const thread = await db.thread.findFirstOrThrow({
      where: { botId, userId: ids.b, departmentId: null },
    });
    expect(row).toMatchObject({ userId: ids.b, threadId: thread.id, active: true });
    expect(queued).toHaveLength(2);
  });

  it("keeps an admin-paused routine paused when a head joins, but runs it as them", async () => {
    const paused = await db.routine.create({
      data: {
        spaceId,
        botId,
        userId: ids.owner,
        name: "Paused",
        prompt: "x",
        crons: ["0 9 * * 1"],
        runsAsDepartmentHead: true,
      },
    });
    await sync.syncDepartmentRoutines(deps(), departmentId);
    expect(await db.routine.findUniqueOrThrow({ where: { id: paused.id } })).toMatchObject({
      userId: ids.b,
      personCreated: true,
      active: false,
      waitingForHead: false,
      nextRunAt: null,
    });
    expect(queued).toHaveLength(2);
    await db.routine.delete({ where: { id: paused.id } });
  });

  it("leaves routines that do not run as the head alone", async () => {
    const other = await db.routine.create({
      data: { spaceId, botId, userId: ids.plain, name: "Own", prompt: "x", crons: ["0 9 * * *"] },
    });
    await sync.syncDepartmentRoutines(deps(), departmentId);
    expect(await db.routine.findUniqueOrThrow({ where: { id: other.id } })).toMatchObject({
      userId: ids.plain,
      active: false,
    });
  });

  it("keeps a bot in two departments running as the head of the one that has one", async () => {
    const other = await db.department.create({ data: { spaceId, name: `Other ${stamp}` } });
    await db.departmentBot.create({ data: { departmentId: other.id, botId } });
    await sync.syncDepartmentRoutines(deps(), other.id);
    expect(await routine()).toMatchObject({ userId: ids.b, active: true });
    const botIds = await sync.departmentBotIds(deps(), other.id);
    await db.department.delete({ where: { id: other.id } });
    await sync.stopHeadRoutines(deps(), botIds);
    expect(await routine()).toMatchObject({ userId: ids.b, active: true });
  });

  it("starts an invited head's routines once their first sign-in saves a token", async () => {
    const dept = await db.department.create({ data: { spaceId, name: `Invited ${stamp}` } });
    const bot = await db.bot.create({
      data: { spaceId, userId: ids.owner, name: "Invited", color: "#3B82F6" },
    });
    await db.departmentBot.create({ data: { departmentId: dept.id, botId: bot.id } });
    const waiting = await db.routine.create({
      data: {
        spaceId,
        botId: bot.id,
        userId: ids.owner,
        name: "Daily",
        prompt: "x",
        crons: ["0 9 * * *"],
        runsAsDepartmentHead: true,
        waitingForHead: true,
      },
    });
    const row = () => db.routine.findUniqueOrThrow({ where: { id: waiting.id } });
    // Admission accepts the invitation before the session, and so the token, exists.
    await db.departmentUser.create({
      data: { departmentId: dept.id, userId: ids.plain, role: "head" },
    });
    await sync.syncDepartmentRoutines(deps(), dept.id);
    expect(await row()).toMatchObject({ active: false, waitingForHead: true });
    await db.secret.create({
      data: { userId: ids.plain, spaceId: null, kind: "sso-token", ciphertext: "x" },
    });
    await sync.syncHeadRoutines(deps(), ids.plain);
    expect(await row()).toMatchObject({
      userId: ids.plain,
      active: true,
      waitingForHead: false,
      personCreated: true,
    });
    // The head's token lapses and they leave: it waits again for the next head.
    await db.departmentUser.deleteMany({ where: { departmentId: dept.id } });
    await sync.syncDepartmentRoutines(deps(), dept.id);
    expect(await row()).toMatchObject({ userId: ids.owner, active: false, waitingForHead: true });
    await db.department.delete({ where: { id: dept.id } });
    await db.bot.delete({ where: { id: bot.id } });
  });

  it("switches head routines off when the department is removed", async () => {
    const botIds = await sync.departmentBotIds(deps(), departmentId);
    expect(botIds).toEqual([botId]);
    await db.department.delete({ where: { id: departmentId } });
    await sync.stopHeadRoutines(deps(), botIds);
    expect(await routine()).toMatchObject({
      userId: ids.owner,
      threadId: null,
      personCreated: false,
      active: false,
      waitingForHead: true,
      nextRunAt: null,
    });
  });
});
