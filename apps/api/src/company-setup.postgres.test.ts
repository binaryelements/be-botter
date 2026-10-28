import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runJobKey } from "@rakazo/adapter-kit";
import { ComposioConnector, FakeComposioClient } from "@rakazo/adapters";
import { asSystem, joinSpace } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { createApp } from "./app.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
type AppHandles = Awaited<ReturnType<typeof createApp>>;

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

const ORIGIN = "http://127.0.0.1:5173";

async function signup(app: App, email: string, name: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, password: "password12", name }),
  });
  if (response.status >= 400) throw new Error(`signup failed ${response.status}`);
  const { user } = (await response.json()) as { user: { id: string } };
  const cookie = response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { cookie, userId: user.id };
}

async function raw(app: App, cookie: string, procedure: string, body: unknown = {}) {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: ORIGIN },
    body: JSON.stringify({ json: body }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    json?: any;
    error?: { message?: string };
  };
  return {
    status: response.status,
    json: payload.json,
    message: payload.error?.message ?? payload.json?.message,
  };
}

const PROCEDURES: [string, unknown][] = [
  ["setup/get", {}],
  ["setup/templates", {}],
  ["setup/createCompany", { name: "Nope" }],
  ["setup/addDepartment", { name: "Nope", instructions: "x" }],
  ["setup/setDepartmentTools", { departmentId: "x", disabledTools: [] }],
  ["setup/update", { signInMode: "invited" }],
  ["setup/markReady", {}],
  ["setup/reset", { confirmName: "Nope" }],
];

describePostgres("setup over the API (PostgreSQL)", () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-setup-"));
  let handles: AppHandles;
  let app: App;
  let db: AppHandles["prisma"];
  let superadmin: { cookie: string; userId: string };
  let stranger: { cookie: string; userId: string };
  // Signed up before the company is ready: afterwards only SSO admits newcomers.
  let trialOwner: { cookie: string; userId: string };
  let trialStaff: { cookie: string; userId: string };
  const company = `Acme ${stamp}`;
  let saved: Record<string, unknown> | null;
  const takeResetBackup = vi.fn(async () => `reset-${stamp}.dump`);

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
      takeResetBackup,
    });
    app = handles.app;
    db = asSystem(handles.prisma);
    superadmin = await signup(app, `setup-admin-${stamp}@rakazo.test`, "Admin");
    stranger = await signup(app, `setup-other-${stamp}@rakazo.test`, "Other");
    trialOwner = await signup(app, `setup-owner-${stamp}@rakazo.test`, "Owner");
    trialStaff = await signup(app, `setup-staff-${stamp}@rakazo.test`, "Staff");
    saved = await db.deploymentSettings.findUnique({ where: { id: "default" } });
    await db.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", ownerUserId: superadmin.userId },
      update: {
        ownerUserId: superadmin.userId,
        companySpaceId: null,
        companyOwnerEmail: null,
        companyReadyAt: null,
        signInMode: "invited",
      },
    });
  });

  afterAll(async () => {
    if (saved) {
      const { id: _id, ...rest } = saved as { id: string };
      await db.deploymentSettings.update({ where: { id: "default" }, data: rest as never });
    } else {
      await db.deploymentSettings.deleteMany({ where: { id: "default" } });
    }
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("is forbidden to everyone but the superadmin", async () => {
    for (const [procedure, body] of PROCEDURES) {
      expect((await raw(app, stranger.cookie, procedure, body)).status, procedure).toBe(403);
    }
  });

  it("treats a fresh site's company Space, the superadmin's own, as no company yet", async () => {
    const personal = await db.spaceMember.findFirstOrThrow({
      where: { userId: superadmin.userId, space: { isDefault: true } },
      select: { spaceId: true },
    });
    await db.deploymentSettings.update({
      where: { id: "default" },
      data: { companySpaceId: personal.spaceId },
    });
    const setup = await raw(app, superadmin.cookie, "setup/get");
    expect(setup.json).toMatchObject({ companySpaceId: null, companyName: null, departments: [] });
    const department = await raw(app, superadmin.cookie, "setup/addDepartment", {
      name: "Accounts",
      instructions: "x",
    });
    expect(department.status).toBe(400);
    expect(department.message).toBe("Create the company first.");
  });

  it("refuses to be ready without an owner email or a department", async () => {
    await raw(app, superadmin.cookie, "setup/createCompany", { name: company });
    const noEmail = await raw(app, superadmin.cookie, "setup/markReady");
    expect(noEmail.status).toBe(400);
    expect(noEmail.message).toBe("Add the owner's email first.");
    expect(
      (await raw(app, superadmin.cookie, "setup/update", { ownerEmail: "Boss@Acme.Test" })).status,
    ).toBe(200);
    const noDept = await raw(app, superadmin.cookie, "setup/markReady");
    expect(noDept.status).toBe(400);
    expect(noDept.message).toBe("Add at least one department first.");
  });

  it("creates the company once", async () => {
    const again = await raw(app, superadmin.cookie, "setup/createCompany", { name: "Acme Two" });
    expect(again.status).toBe(409);
    const setup = await raw(app, superadmin.cookie, "setup/get");
    expect(setup.json).toMatchObject({
      companyName: company,
      ownerEmail: "boss@acme.test",
      readyAt: null,
      departments: [],
    });
  });

  it("refuses a department over the computer cap and leaves nothing behind", async () => {
    // The superadmin's own bot holds the only computer slot.
    expect((await raw(app, superadmin.cookie, "bots/create", { name: "Own bot" })).status).toBe(
      200,
    );
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
    try {
      const added = await raw(app, superadmin.cookie, "setup/addDepartment", {
        name: "Accounts",
        instructions: "x",
      });
      expect(added.status).toBe(400);
      expect(added.message).toBe("User computer limit (1) reached");
    } finally {
      delete process.env.SANDBOX_MAX_COMPUTERS_PER_USER;
    }
    const space = await db.space.findFirstOrThrow({ where: { name: company } });
    expect(await db.department.count({ where: { spaceId: space.id } })).toBe(0);
    expect((await raw(app, superadmin.cookie, "setup/get")).json.departments).toEqual([]);
  });

  it("adds a department from the accounts template with rendered persona and head routines", async () => {
    const templates = await raw(app, superadmin.cookie, "setup/templates");
    const accounts = (
      templates.json as { id: string; instructions: string; routines: unknown[] }[]
    ).find((template) => template.id === "accounts")!;
    const added = await raw(app, superadmin.cookie, "setup/addDepartment", {
      name: "Accounts",
      instructions: accounts.instructions,
      templateId: "accounts",
    });
    expect(added.status).toBe(200);
    const bot = await db.bot.findUniqueOrThrow({ where: { id: added.json.botId } });
    const space = await db.space.findFirstOrThrow({ where: { name: company } });
    expect(bot.spaceId).toBe(space.id);
    expect(bot.instructions).toContain(company);
    expect(bot.instructions).not.toContain("{company}");
    expect(bot.instructions).not.toContain("{department}");
    const routines = await db.routine.findMany({ where: { botId: bot.id } });
    expect(routines).toHaveLength(accounts.routines.length);
    expect(routines.length).toBe(2);
    for (const routine of routines) {
      expect(routine).toMatchObject({
        active: false,
        personCreated: false,
        runsAsDepartmentHead: true,
        spaceId: space.id,
        userId: superadmin.userId,
      });
    }
    const setup = await raw(app, superadmin.cookie, "setup/get");
    expect(setup.json.departments).toEqual([
      {
        id: added.json.departmentId,
        name: "Accounts",
        botId: bot.id,
        botName: bot.name,
        disabledTools: [],
      },
    ]);
    const unknown = await raw(app, superadmin.cookie, "setup/addDepartment", {
      name: "Ghost",
      instructions: "x",
      templateId: "nope",
    });
    expect(unknown.status).toBe(400);
  });

  it("stores the department's tool choices and lets the superadmin change them", async () => {
    const added = await raw(app, superadmin.cookie, "setup/addDepartment", {
      name: "Sales",
      instructions: "x",
      disabledTools: ["call_user", "end_call"],
    });
    expect(added.status).toBe(200);
    const bot = await db.bot.findUniqueOrThrow({ where: { id: added.json.botId } });
    expect(bot.disabledBuiltinTools).toEqual(["call_user", "end_call"]);
    const setup = await raw(app, superadmin.cookie, "setup/get");
    expect(
      setup.json.departments.find((d: { name: string }) => d.name === "Sales").disabledTools,
    ).toEqual(["call_user", "end_call"]);
    const changed = await raw(app, superadmin.cookie, "setup/setDepartmentTools", {
      departmentId: added.json.departmentId,
      disabledTools: ["web_search", "web_fetch"],
    });
    expect(changed.status).toBe(200);
    expect(changed.json).toEqual({ disabledTools: ["web_fetch", "web_search"] });
    expect(
      (await db.bot.findUniqueOrThrow({ where: { id: added.json.botId } })).disabledBuiltinTools,
    ).toEqual(["web_fetch", "web_search"]);
    expect(
      (
        await raw(app, superadmin.cookie, "setup/setDepartmentTools", {
          departmentId: "missing",
          disabledTools: [],
        })
      ).status,
    ).toBe(404);
  });

  it("keeps tool choices made outside the wizard's groups when switching groups", async () => {
    const sales = (await raw(app, superadmin.cookie, "setup/get")).json.departments.find(
      (d: { name: string }) => d.name === "Sales",
    );
    await db.bot.update({
      where: { id: sales.botId },
      data: { disabledBuiltinTools: ["admin_change", "web_search"] },
    });
    const changed = await raw(app, superadmin.cookie, "setup/setDepartmentTools", {
      departmentId: sales.id,
      disabledTools: ["call_user", "end_call"],
    });
    expect(changed.status).toBe(200);
    expect(changed.json).toEqual({ disabledTools: ["admin_change", "call_user", "end_call"] });
    expect(
      (await db.bot.findUniqueOrThrow({ where: { id: sales.botId } })).disabledBuiltinTools,
    ).toEqual(["admin_change", "call_user", "end_call"]);
    // The reset test below expects the choice the previous test left.
    await db.bot.update({
      where: { id: sales.botId },
      data: { disabledBuiltinTools: ["web_fetch", "web_search"] },
    });
  });

  it("marks the company ready", async () => {
    const ready = await raw(app, superadmin.cookie, "setup/markReady");
    expect(ready.status).toBe(200);
    expect(ready.json.readyAt).toEqual(expect.any(String));
  });

  describe("reset", () => {
    let trial: Awaited<ReturnType<typeof seedTrial>>;

    async function seedTrial() {
      const setup = await raw(app, superadmin.cookie, "setup/get");
      const spaceId = setup.json.companySpaceId as string;
      const department = setup.json.departments[0] as { id: string; botId: string };
      const owner = trialOwner;
      const staff = trialStaff;
      await joinSpace(db, spaceId, owner.userId, "owner");
      await joinSpace(db, spaceId, staff.userId);
      await db.departmentUser.create({
        data: { departmentId: department.id, userId: owner.userId, role: "head" },
      });
      await db.routine.updateMany({
        where: { botId: department.botId },
        data: { active: true, nextRunAt: new Date(Date.now() + 3_600_000) },
      });
      const ownerBot = await db.bot.create({
        data: { spaceId, userId: owner.userId, name: "Owner's bot", color: "blue" },
      });
      const channel = await db.thread.create({
        data: {
          spaceId,
          botId: department.botId,
          userId: owner.userId,
          departmentId: department.id,
        },
      });
      await db.message.create({
        data: { threadId: channel.id, seq: 0, role: "user", blocks: [], userId: owner.userId },
      });
      const task = await db.task.create({
        data: {
          spaceId,
          botId: department.botId,
          threadId: channel.id,
          userId: owner.userId,
          prompt: "work",
          status: "running",
        },
      });
      const run = await db.run.create({
        data: {
          spaceId,
          botId: department.botId,
          threadId: channel.id,
          taskId: task.id,
          userId: owner.userId,
          status: "running",
          trigger: "user",
        },
      });
      await db.memoryDocument.create({
        data: {
          spaceId,
          userId: owner.userId,
          botId: department.botId,
          scope: "bot",
          path: "notes.md",
          content: "trial notes",
        },
      });
      await db.artifact.create({
        data: {
          spaceId,
          botId: department.botId,
          userId: owner.userId,
          name: "report.txt",
          mimeType: "text/plain",
          size: 1,
          hash: "h",
          storageKey: `reset-test-${stamp}`,
        },
      });
      await db.spaceInvitation.create({
        data: {
          spaceId,
          email: `invitee-${stamp}@rakazo.test`,
          createdByUserId: superadmin.userId,
        },
      });
      const ownerComputer = await db.computer.create({
        data: {
          spaceId,
          userId: owner.userId,
          scopeKey: `reset-test-${stamp}`,
          homeKey: `reset-test-${stamp}`,
          kind: "fake",
        },
      });
      const personal = await db.spaceMember.findFirstOrThrow({
        where: { userId: superadmin.userId, spaceId: { not: spaceId } },
      });
      const personalBot = await db.bot.create({
        data: {
          spaceId: personal.spaceId,
          userId: superadmin.userId,
          name: "Personal bot",
          color: "blue",
        },
      });
      const personalThread = await db.thread.create({
        data: { spaceId: personal.spaceId, botId: personalBot.id, userId: superadmin.userId },
      });
      // One row of every other kind of trial content, in the company and in the personal Space.
      const content = async (space: string, botId: string, userId: string) => {
        await db.agentSkill.create({
          data: { spaceId: space, userId, name: "skill", description: "d", content: "c" },
        });
        await db.scratchpadItem.create({ data: { spaceId: space, botId, userId, title: "t" } });
        await db.taughtSkill.create({
          data: { spaceId: space, botId, userId, goal: "g", status: "draft" },
        });
        const group = await db.chatGroup.create({ data: { spaceId: space, userId, name: "g" } });
        await db.chatGroupMember.create({ data: { groupId: group.id, botId } });
        const board = await db.board.upsert({
          where: { spaceId: space },
          create: { spaceId: space },
          update: {},
        });
        const ticket = await db.ticket.create({
          data: {
            boardId: board.id,
            spaceId: space,
            number: Math.floor(Math.random() * 1e9),
            title: "t",
          },
        });
        await db.ticketComment.create({ data: { ticketId: ticket.id, spaceId: space, body: "b" } });
        await db.agentHome.create({ data: { spaceId: space, botId, userId } });
        await db.externalConversation.create({
          data: {
            provider: "teams",
            workspaceId: `w-${stamp}`,
            externalKey: `${space}-${botId}`,
            conversationId: "c",
            spaceId: space,
            botId,
            userId,
          },
        });
      };
      await content(spaceId, department.botId, owner.userId);
      await content(personal.spaceId, personalBot.id, superadmin.userId);
      const departmentComputerId = (
        await db.bot.findUniqueOrThrow({ where: { id: department.botId } })
      ).computerId;
      return {
        departmentComputerId,
        spaceId,
        department,
        owner,
        staff,
        ownerBot,
        ownerComputer,
        channel,
        run,
        personalBot,
        personalThread,
      };
    }

    async function untouched() {
      expect(await db.user.findUnique({ where: { id: trial.owner.userId } })).not.toBeNull();
      expect(await db.thread.findUnique({ where: { id: trial.channel.id } })).not.toBeNull();
      expect(await db.run.findUniqueOrThrow({ where: { id: trial.run.id } })).toMatchObject({
        status: "running",
      });
      expect(await db.spaceInvitation.count({ where: { spaceId: trial.spaceId } })).toBe(1);
    }

    beforeAll(async () => {
      trial = await seedTrial();
    });

    it("refuses a name that is not exactly the company's and deletes nothing", async () => {
      for (const confirmName of [company.toLowerCase(), ` ${company}`, "Acme"]) {
        const refused = await raw(app, superadmin.cookie, "setup/reset", { confirmName });
        expect(refused.status).toBe(400);
        expect(refused.message).toBe("Type the company name to confirm.");
      }
      expect(takeResetBackup).not.toHaveBeenCalled();
      await untouched();
    });

    it("aborts when the backup fails and deletes nothing", async () => {
      takeResetBackup.mockRejectedValueOnce(new Error("pg_dump failed"));
      const failed = await raw(app, superadmin.cookie, "setup/reset", { confirmName: company });
      expect(failed.status).toBeGreaterThanOrEqual(500);
      await untouched();
    });

    it("returns the company to its prepared setup, still ready for the next owner", async () => {
      const cancel = vi.spyOn(handles.jobs, "cancel");
      takeResetBackup.mockClear();
      const reset = await raw(app, superadmin.cookie, "setup/reset", { confirmName: company });
      expect(reset.status).toBe(200);
      expect(takeResetBackup).toHaveBeenCalledTimes(1);
      expect(reset.json).toMatchObject({
        companyName: company,
        ownerEmail: "boss@acme.test",
        readyAt: expect.any(String),
        tenantId: null,
      });

      // The running run was cancelled before its thread went.
      expect(cancel).toHaveBeenCalledWith(runJobKey(trial.run.id));
      expect(await db.run.findUnique({ where: { id: trial.run.id } })).toBeNull();

      // Only the superadmin is left among the company's people; the others are deleted.
      const members = await db.spaceMember.findMany({ where: { spaceId: trial.spaceId } });
      expect(members.map((member) => member.userId)).toEqual([superadmin.userId]);
      for (const person of [trial.owner, trial.staff]) {
        expect(await db.user.findUnique({ where: { id: person.userId } })).toBeNull();
      }
      expect(await db.bot.findUnique({ where: { id: trial.ownerBot.id } })).toBeNull();
      expect(await db.computer.findUnique({ where: { id: trial.ownerComputer.id } })).toBeNull();

      // The department and its bot stay, with a fresh home thread and nothing else.
      const bot = await db.bot.findUniqueOrThrow({ where: { id: trial.department.botId } });
      const threads = await db.thread.findMany({ where: { botId: bot.id } });
      expect(threads.map((thread) => thread.id)).toEqual([bot.homeThreadId]);
      expect(threads[0]).toMatchObject({ userId: superadmin.userId, departmentId: null });
      expect(await db.message.count({ where: { threadId: threads[0]!.id } })).toBe(0);
      expect(await db.memoryDocument.count({ where: { botId: bot.id } })).toBe(0);
      expect(await db.artifact.count({ where: { spaceId: trial.spaceId } })).toBe(0);
      expect(await db.department.count({ where: { spaceId: trial.spaceId } })).toBe(2);
      const routines = await db.routine.findMany({ where: { botId: bot.id } });
      expect(routines).toHaveLength(2);
      for (const routine of routines) expect(routine.active).toBe(false);
      // The Sales bot keeps its tool choices.
      expect(
        (
          await db.bot.findFirstOrThrow({
            where: { spaceId: trial.spaceId, name: "Sales Assistant" },
          })
        ).disabledBuiltinTools,
      ).toEqual(["web_fetch", "web_search"]);

      expect(await db.spaceInvitation.count({ where: { spaceId: trial.spaceId } })).toBe(0);
      const event = await db.securityEvent.findFirst({
        where: { type: "configuration.changed", userId: superadmin.userId },
        orderBy: { createdAt: "desc" },
      });
      expect(event?.metadata).toMatchObject({
        procedure: "setup.reset",
        backup: `reset-${stamp}.dump`,
        outcome: "completed",
      });
      const started = await db.securityEvent.count({
        where: {
          type: "configuration.changed",
          userId: superadmin.userId,
          metadata: { path: ["outcome"], equals: "started" },
        },
      });
      expect(started).toBe(1);

      // Every other kind of trial content is gone; the bot starts like a new one.
      const where = { spaceId: trial.spaceId };
      const counts = await Promise.all([
        db.agentSkill.count({ where }),
        db.scratchpadItem.count({ where }),
        db.taughtSkill.count({ where }),
        db.chatGroup.count({ where }),
        db.board.count({ where }),
        db.ticket.count({ where }),
        db.ticketComment.count({ where }),
        db.agentHome.count({ where }),
        db.externalConversation.count({ where }),
      ]);
      expect(counts).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
      expect(await db.browserProfile.findMany({ where })).toMatchObject([
        { botId: bot.id, userId: superadmin.userId },
        { userId: superadmin.userId },
      ]);
      // Its computer, which the superadmin owns, is destroyed and replaced by a fresh one.
      expect(trial.departmentComputerId).toEqual(expect.any(String));
      expect(
        await db.computer.findUnique({ where: { id: trial.departmentComputerId! } }),
      ).toBeNull();
      expect(bot.computerId).not.toBeNull();
      expect(bot.computerId).not.toBe(trial.departmentComputerId);
      expect(await db.computer.findUniqueOrThrow({ where: { id: bot.computerId! } })).toMatchObject(
        { spaceId: trial.spaceId, userId: superadmin.userId, state: "stopped" },
      );

      // The superadmin's own Space is never touched.
      const personalWhere = { spaceId: trial.personalBot.spaceId };
      const personalCounts = await Promise.all([
        db.agentSkill.count({ where: personalWhere }),
        db.scratchpadItem.count({ where: personalWhere }),
        db.taughtSkill.count({ where: personalWhere }),
        db.chatGroup.count({ where: personalWhere }),
        db.ticketComment.count({ where: personalWhere }),
        db.agentHome.count({ where: personalWhere }),
        db.externalConversation.count({ where: personalWhere }),
      ]);
      for (const count of personalCounts) expect(count).toBeGreaterThan(0);
      expect(await db.bot.findUnique({ where: { id: trial.personalBot.id } })).not.toBeNull();
      expect(await db.thread.findUnique({ where: { id: trial.personalThread.id } })).not.toBeNull();
      expect(await db.user.findUnique({ where: { id: superadmin.userId } })).not.toBeNull();
    });
  });
});
