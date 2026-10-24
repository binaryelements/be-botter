import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioConnector, FakeComposioClient } from "@rakazo/adapters";
import type { Department, Me, SpaceNavigation } from "@rakazo/contracts";
import { asSystem, homeThread } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

function sessionCookie(response: Response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

async function signup(app: App, email: string, name: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, password: "password12", name }),
  });
  if (response.status >= 400) {
    throw new Error(`signup failed ${response.status}: ${await response.text()}`);
  }
  const { user } = (await response.json()) as { user: { id: string } };
  return { cookie: sessionCookie(response), userId: user.id };
}

async function raw(app: App, cookie: string, procedure: string, body: unknown, spaceId?: string) {
  return app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
      origin: ORIGIN,
    },
    body: JSON.stringify({ json: body ?? {} }),
  });
}

async function rpc<T>(
  app: App,
  cookie: string,
  procedure: string,
  body: unknown = {},
  spaceId?: string,
): Promise<T> {
  const response = await raw(app, cookie, procedure, body, spaceId);
  const text = await response.text();
  const payload = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (response.status >= 400 || payload.error) {
    throw new Error(`${procedure} ${response.status}: ${payload.error?.message ?? text}`);
  }
  return payload.json as T;
}

async function status(
  app: App,
  cookie: string,
  procedure: string,
  body: unknown,
  spaceId?: string,
) {
  return (await raw(app, cookie, procedure, body, spaceId)).status;
}

describePostgres("departments over the API (PostgreSQL)", () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-departments-"));
  let handles: AppHandles;
  let app: App;
  let db: AppHandles["prisma"];
  let owner: { cookie: string; userId: string };
  let staff: { cookie: string; userId: string };
  const staffEmail = `dept-staff-${stamp}@rakazo.test`;
  let companySpaceId: string;
  let itBotId: string;
  let chiefBotId: string;
  let itDepartmentId: string;
  let salesDepartmentId: string;

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
    app = handles.app;
    db = asSystem(handles.prisma);
    owner = await signup(app, `dept-owner-${stamp}@rakazo.test`, "Owner");
    staff = await signup(app, staffEmail, "IT Staff");
    const me = await rpc<Me>(app, owner.cookie, "me");
    companySpaceId = me.spaceId;
    const createBot = async (name: string) => {
      const bot = await db.bot.create({
        data: { spaceId: companySpaceId, userId: owner.userId, name, color: "#3B82F6" },
      });
      await homeThread(db, bot);
      return bot.id;
    };
    itBotId = await createBot("IT Support");
    chiefBotId = await createBot("Chief");
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("keeps the company space out of a stranger's navigation and bot list", async () => {
    const navigation = await rpc<SpaceNavigation>(app, staff.cookie, "spaces/list");
    expect(navigation.spaces.map((space) => space.id)).not.toContain(companySpaceId);
    expect(await status(app, staff.cookie, "bots/list", {}, companySpaceId)).toBe(401);
  });

  it("lets the owner create a department and add a person by email", async () => {
    const created = await rpc<Department>(app, owner.cookie, "departments/create", { name: "IT" });
    itDepartmentId = created.id;
    expect(created).toEqual({
      id: itDepartmentId,
      name: "IT",
      users: [],
      botIds: [],
      canManageUsers: true,
    });
    const updated = await rpc<Department>(app, owner.cookie, "departments/setUsers", {
      departmentId: itDepartmentId,
      users: [{ email: staffEmail.toUpperCase(), role: "member" }],
    });
    expect(updated.users).toEqual([
      { userId: staff.userId, email: staffEmail, name: "IT Staff", role: "member" },
    ]);
    const unknown = await raw(app, owner.cookie, "departments/setUsers", {
      departmentId: itDepartmentId,
      users: [{ email: `nobody-${stamp}@rakazo.test`, role: "member" }],
    });
    expect(unknown.status).toBe(400);
  });

  it("shows the person the company space once they are in a department", async () => {
    const navigation = await rpc<SpaceNavigation>(app, staff.cookie, "spaces/list");
    expect(navigation.spaces.map((space) => space.id)).toContain(companySpaceId);
    const me = await rpc<Me>(app, staff.cookie, "me", {}, companySpaceId);
    expect(me.spaceId).toBe(companySpaceId);
    expect(me.isSpaceOwner).toBe(false);
    const ownerMe = await rpc<Me>(app, owner.cookie, "me");
    expect(ownerMe.isSpaceOwner).toBe(true);
  });

  it("lists departments to members but leaves managing them to owners and heads", async () => {
    const listed = await rpc<Department[]>(
      app,
      staff.cookie,
      "departments/list",
      {},
      companySpaceId,
    );
    expect(listed.map((department) => [department.name, department.canManageUsers])).toEqual([
      ["IT", false],
    ]);
    expect(
      await status(app, staff.cookie, "departments/create", { name: "Accounts" }, companySpaceId),
    ).toBe(403);
    expect(
      await status(
        app,
        staff.cookie,
        "departments/setUsers",
        { departmentId: itDepartmentId, users: [] },
        companySpaceId,
      ),
    ).toBe(403);
    expect(
      await status(
        app,
        staff.cookie,
        "bots/setDepartments",
        { botId: itBotId, departmentIds: [itDepartmentId] },
        companySpaceId,
      ),
    ).toBe(403);
  });

  it("gives a department member the department's bots and their threads", async () => {
    expect(await rpc<unknown[]>(app, staff.cookie, "bots/list", {}, companySpaceId)).toEqual([]);
    const assigned = await rpc<{ departmentIds: string[] }>(
      app,
      owner.cookie,
      "bots/setDepartments",
      { botId: itBotId, departmentIds: [itDepartmentId] },
    );
    expect(assigned).toEqual({ departmentIds: [itDepartmentId] });
    const bots = await rpc<{ id: string; name: string }[]>(
      app,
      staff.cookie,
      "bots/list",
      {},
      companySpaceId,
    );
    expect(bots.map((bot) => bot.name)).toEqual(["IT Support"]);
    expect(await status(app, staff.cookie, "bots/get", { botId: chiefBotId }, companySpaceId)).toBe(
      404,
    );
    // The owner's conversation stays theirs; the member gets a private thread of their own.
    const home = await db.thread.findFirstOrThrow({ where: { homeOf: { id: itBotId } } });
    await rpc(app, owner.cookie, "threads/send", { botId: itBotId, text: "Owner note" });
    const mine = await rpc<{ threadId: string; messages: unknown[] }>(
      app,
      staff.cookie,
      "threads/get",
      { botId: itBotId },
      companySpaceId,
    );
    expect(mine.threadId).not.toBe(home.id);
    expect(mine.messages).toEqual([]);
    const sent = await rpc<{ runId: string }>(
      app,
      staff.cookie,
      "threads/send",
      { botId: itBotId, text: "Hello from IT" },
      companySpaceId,
    );
    const run = await db.run.findUniqueOrThrow({ where: { id: sent.runId } });
    expect(run.userId).toBe(staff.userId);
    expect(run.botId).toBe(itBotId);
    expect(run.threadId).toBe(mine.threadId);
    const ownerView = await rpc<{ threadId: string; messages: unknown[] }>(
      app,
      owner.cookie,
      "threads/get",
      { botId: itBotId },
    );
    expect(ownerView.threadId).toBe(home.id);
    expect(JSON.stringify(ownerView.messages)).not.toContain("Hello from IT");
    const staffBot = await rpc<{ threadId: string }>(
      app,
      staff.cookie,
      "bots/get",
      { botId: itBotId },
      companySpaceId,
    );
    expect(staffBot.threadId).toBe(mine.threadId);
    const again = await rpc<{ threadId: string }>(
      app,
      staff.cookie,
      "threads/get",
      { botId: itBotId },
      companySpaceId,
    );
    expect(again.threadId).toBe(mine.threadId);
  });

  it("lets the member use what belongs to the shared bot and nothing of the private one", async () => {
    const seed = async (botId: string, label: string) => {
      const thread = await db.thread.findFirstOrThrow({ where: { homeOf: { id: botId } } });
      const base = { spaceId: companySpaceId, botId, userId: owner.userId };
      const routine = await db.routine.create({
        data: { ...base, name: `${label} routine`, prompt: `Check ${label}`, crons: [] },
      });
      await db.memoryDocument.create({
        data: { ...base, scope: "bot", path: `${label}/notes.md`, content: `${label} notes` },
      });
      const artifact = await db.artifact.create({
        data: {
          ...base,
          name: `${label}.txt`,
          mimeType: "text/plain",
          size: 1,
          hash: `hash-${label}`,
          storageKey: `key-${label}`,
        },
      });
      const task = await db.task.create({
        data: { ...base, threadId: thread.id, prompt: `Check ${label}`, status: "completed" },
      });
      const run = await db.run.create({
        data: {
          ...base,
          threadId: thread.id,
          taskId: task.id,
          status: "completed",
          trigger: "user",
        },
      });
      const skill = await db.taughtSkill.create({
        data: {
          ...base,
          goal: `${label} goal`,
          status: "saved",
          playbook: {
            whenToUse: "",
            inputs: [],
            steps: [],
            howToCheck: "",
            whatToReturn: "",
            approvalBoundaries: "",
          },
        },
      });
      return { routine, artifact, run, skill };
    };
    const shared = await seed(itBotId, "it");
    const hidden = await seed(chiefBotId, "chief");
    const call = <T>(procedure: string, body: unknown) =>
      rpc<T>(app, staff.cookie, procedure, body, companySpaceId);
    /** The private bot yields nothing: either not found, or an empty list. */
    const nothing = async (procedure: string, body: unknown) => {
      const response = await raw(app, staff.cookie, procedure, body, companySpaceId);
      if (response.status === 404) return true;
      const payload = JSON.parse(await response.text()) as { json?: unknown[] };
      return response.status === 200 && payload.json?.length === 0;
    };

    const routines = await call<{ id: string }[]>("routines/list", { botId: itBotId });
    expect(routines.map((routine) => routine.id)).toEqual([shared.routine.id]);
    expect(await nothing("routines/list", { botId: chiefBotId })).toBe(true);
    const artifacts = await call<{ id: string }[]>("artifacts/list", { botId: itBotId });
    expect(artifacts.map((artifact) => artifact.id)).toEqual([shared.artifact.id]);
    expect(await nothing("artifacts/list", { botId: chiefBotId })).toBe(true);
    const skills = await call<{ id: string }[]>("skills/list", { botId: itBotId });
    expect(skills.map((skill) => skill.id)).toEqual([shared.skill.id]);
    expect(await nothing("skills/list", { botId: chiefBotId })).toBe(true);
    const memory = await call<{ path: string }[]>("memory/list", {});
    expect(memory.map((doc) => doc.path)).toEqual(["it/notes.md"]);
    const runs = JSON.stringify(await call("runs/list", { filter: "recent" }));
    expect(runs).toContain(shared.run.id);
    expect(runs).not.toContain(hidden.run.id);
    const hits = JSON.stringify(await call("search/query", { q: "routine" }));
    expect(hits).toContain("it routine");
    expect(hits).not.toContain("chief routine");
    await call("threads/markRead", { botId: itBotId });
    expect(
      await status(app, staff.cookie, "threads/markRead", { botId: chiefBotId }, companySpaceId),
    ).toBe(404);
  });

  it("takes the access away when the department goes", async () => {
    await rpc(app, owner.cookie, "departments/remove", { departmentId: itDepartmentId });
    expect(await rpc<unknown[]>(app, staff.cookie, "bots/list", {}, companySpaceId)).toEqual([]);
    expect(await status(app, staff.cookie, "threads/get", { botId: itBotId }, companySpaceId)).toBe(
      404,
    );
  });
  it("opens a department channel for the department's people and refuses everyone else", async () => {
    // The previous test removed IT; build it again with the same people and bot.
    const rebuilt = await rpc<{ id: string }>(app, owner.cookie, "departments/create", {
      name: "IT",
    });
    itDepartmentId = rebuilt.id;
    await rpc(app, owner.cookie, "departments/setUsers", {
      departmentId: itDepartmentId,
      users: [{ email: staffEmail, role: "member" }],
    });
    await rpc(app, owner.cookie, "bots/setDepartments", {
      botId: itBotId,
      departmentIds: [itDepartmentId],
    });
    const channel = { botId: itBotId, departmentId: itDepartmentId };
    const owners = await rpc<{ threadId: string; departmentId?: string }>(
      app,
      owner.cookie,
      "threads/get",
      channel,
    );
    expect(owners.departmentId).toBe(itDepartmentId);
    const staffs = await rpc<{ threadId: string }>(
      app,
      staff.cookie,
      "threads/get",
      channel,
      companySpaceId,
    );
    expect(staffs.threadId).toBe(owners.threadId);
    const mine = await rpc<{ threadId: string }>(
      app,
      staff.cookie,
      "threads/get",
      { botId: itBotId },
      companySpaceId,
    );
    expect(mine.threadId).not.toBe(owners.threadId);
    // A bot outside the department has no channel there, for anyone.
    expect(
      await status(app, owner.cookie, "threads/get", {
        botId: chiefBotId,
        departmentId: itDepartmentId,
      }),
    ).toBe(403);
    // A department the person is not in stays closed even when the bot is in it.
    const sales = await rpc<{ id: string }>(app, owner.cookie, "departments/create", {
      name: "Sales",
    });
    salesDepartmentId = sales.id;
    await rpc(app, owner.cookie, "bots/setDepartments", {
      botId: itBotId,
      departmentIds: [itDepartmentId, sales.id],
    });
    expect(
      await status(
        app,
        staff.cookie,
        "threads/get",
        { botId: itBotId, departmentId: sales.id },
        companySpaceId,
      ),
    ).toBe(403);
    // One shared conversation: a member's message reaches the owner, and clearing clears for both.
    await rpc(
      app,
      staff.cookie,
      "threads/send",
      { ...channel, text: "Team question" },
      companySpaceId,
    );
    const shared = await rpc<{ messages: unknown[] }>(app, owner.cookie, "threads/get", channel);
    expect(JSON.stringify(shared.messages)).toContain("Team question");
    await rpc(app, staff.cookie, "threads/clear", channel, companySpaceId);
    expect(
      (await rpc<{ messages: unknown[] }>(app, owner.cookie, "threads/get", channel)).messages,
    ).toEqual([]);
  });

  it("lets owners and department heads read, not write, their people's private threads", async () => {
    const head = await signup(app, `dept-head-${stamp}@rakazo.test`, "IT Head");
    const salesHead = await signup(app, `dept-sales-head-${stamp}@rakazo.test`, "Sales Head");
    await rpc(app, owner.cookie, "departments/setUsers", {
      departmentId: itDepartmentId,
      users: [
        { email: staffEmail, role: "member" },
        { email: `dept-head-${stamp}@rakazo.test`, role: "head" },
      ],
    });
    await rpc(app, owner.cookie, "departments/setUsers", {
      departmentId: salesDepartmentId,
      users: [{ email: `dept-sales-head-${stamp}@rakazo.test`, role: "head" }],
    });
    const mine = await rpc<{ threadId: string }>(
      app,
      staff.cookie,
      "threads/get",
      { botId: itBotId },
      companySpaceId,
    );
    const theirs = { botId: itBotId, userId: staff.userId };
    const supervised = await rpc<{
      threadId: string;
      userId?: string;
      readOnly?: boolean;
      messages: unknown[];
    }>(app, owner.cookie, "threads/get", theirs);
    expect(supervised).toMatchObject({
      threadId: mine.threadId,
      userId: staff.userId,
      readOnly: true,
    });
    expect(JSON.stringify(supervised.messages)).toContain("Hello from IT");
    expect(await status(app, owner.cookie, "threads/send", { ...theirs, text: "Nope" })).toBe(403);
    expect(await status(app, owner.cookie, "threads/clear", theirs)).toBe(403);
    const before = await db.thread.findUniqueOrThrow({
      where: { id: mine.threadId },
      select: { unread: true, lastReadSeq: true },
    });
    expect(await status(app, owner.cookie, "threads/markRead", theirs)).toBe(200);
    expect(
      await db.thread.findUniqueOrThrow({
        where: { id: mine.threadId },
        select: { unread: true, lastReadSeq: true },
      }),
    ).toEqual(before);
    const byHead = await rpc<{ threadId: string; readOnly?: boolean }>(
      app,
      head.cookie,
      "threads/get",
      theirs,
      companySpaceId,
    );
    expect(byHead).toMatchObject({ threadId: mine.threadId, readOnly: true });
    expect(await status(app, salesHead.cookie, "threads/get", theirs, companySpaceId)).toBe(403);
    expect(
      await status(
        app,
        staff.cookie,
        "threads/get",
        { botId: itBotId, userId: owner.userId },
        companySpaceId,
      ),
    ).toBe(403);
    expect(
      await status(
        app,
        staff.cookie,
        "threads/get",
        { botId: itBotId, userId: head.userId },
        companySpaceId,
      ),
    ).toBe(403);

    type Entry = {
      kind: string;
      name?: string;
      departmentId?: string;
      userId?: string;
      threadId: string;
    };
    const label = (entry: Entry) => [entry.kind, entry.name ?? null];
    const ownersList = await rpc<Entry[]>(app, owner.cookie, "bots/threads", { botId: itBotId });
    expect(ownersList.map(label)).toEqual([
      ["private", null],
      ["channel", "IT"],
      ["channel", "Sales"],
      ["private", "IT Head"],
      ["private", "IT Staff"],
      ["private", "Sales Head"],
    ]);
    expect(ownersList[0]?.userId).toBe(owner.userId);
    expect(ownersList[1]?.departmentId).toBe(itDepartmentId);
    const headsList = await rpc<Entry[]>(
      app,
      head.cookie,
      "bots/threads",
      { botId: itBotId },
      companySpaceId,
    );
    expect(headsList.map(label)).toEqual([
      ["private", null],
      ["channel", "IT"],
      ["private", "IT Staff"],
    ]);
    expect(headsList[2]?.threadId).toBe(mine.threadId);
    const staffsList = await rpc<Entry[]>(
      app,
      staff.cookie,
      "bots/threads",
      { botId: itBotId },
      companySpaceId,
    );
    expect(staffsList.map(label)).toEqual([
      ["private", null],
      ["channel", "IT"],
    ]);
  });
});
