import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioConnector, FakeComposioClient } from "@rakazo/adapters";
import type { Department, Me, SpaceNavigation } from "@rakazo/contracts";
import { asSystem } from "@rakazo/db";
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
      await db.thread.create({
        data: { spaceId: companySpaceId, userId: owner.userId, botId: bot.id },
      });
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
    await rpc(app, staff.cookie, "threads/get", { botId: itBotId }, companySpaceId);
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
  });

  it("takes the access away when the department goes", async () => {
    await rpc(app, owner.cookie, "departments/remove", { departmentId: itDepartmentId });
    expect(await rpc<unknown[]>(app, staff.cookie, "bots/list", {}, companySpaceId)).toEqual([]);
    expect(await status(app, staff.cookie, "threads/get", { botId: itBotId }, companySpaceId)).toBe(
      404,
    );
  });
});
