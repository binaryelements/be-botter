import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioConnector, FakeComposioClient } from "@rakazo/adapters";
import type { Me } from "@rakazo/contracts";
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

describePostgres("company model connection over the API (PostgreSQL)", () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-company-model-"));
  let handles: AppHandles;
  let app: App;
  let db: AppHandles["prisma"];
  let owner: { cookie: string; userId: string };
  let staff: { cookie: string; userId: string };
  const staffEmail = `company-staff-${stamp}@rakazo.test`;
  let companySpaceId: string;
  const connection = {
    provider: "openrouter",
    apiKey: "sk-or-v1-test-company-key-0000000000",
    modelId: "qwen/qwen3-vl-8b-instruct",
    label: "Company",
  };

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
    owner = await signup(app, `company-owner-${stamp}@rakazo.test`, "Owner");
    staff = await signup(app, staffEmail, "Staff");
    companySpaceId = (await rpc<Me>(app, owner.cookie, "me")).spaceId;
    // Membership of the company space comes with a department, as for every member.
    const department = await rpc<{ id: string }>(app, owner.cookie, "departments/create", {
      name: "Staff",
    });
    await rpc(app, owner.cookie, "departments/setUsers", {
      departmentId: department.id,
      users: [{ email: staffEmail, role: "member" }],
    });
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("is absent until an owner connects one, and members cannot set it", async () => {
    expect(await rpc(app, staff.cookie, "models/companyConnection", {}, companySpaceId)).toBeNull();
    expect(
      await status(app, staff.cookie, "models/setCompanyConnection", connection, companySpaceId),
    ).toBe(403);
  });

  it("serves every member once the owner connects it, and goes away when cleared", async () => {
    const before = await rpc<Me>(app, staff.cookie, "me", {}, companySpaceId);
    const set = await rpc<Record<string, unknown>>(
      app,
      owner.cookie,
      "models/setCompanyConnection",
      connection,
    );
    expect(set).toMatchObject({
      provider: "openrouter",
      modelId: "qwen/qwen3-vl-8b-instruct",
      label: "Company",
      canManage: true,
    });
    expect(
      await rpc(app, staff.cookie, "models/companyConnection", {}, companySpaceId),
    ).toMatchObject({ provider: "openrouter", canManage: false });
    const me = await rpc<Me>(app, staff.cookie, "me", {}, companySpaceId);
    expect(me.defaultProvider).toBe("openrouter");
    expect(me.defaultModel).toBe("qwen/qwen3-vl-8b-instruct");
    // The company's key is nobody's personal connection.
    expect(await rpc(app, staff.cookie, "models/credentials", {}, companySpaceId)).toEqual([]);
    const catalog = await rpc<{ provider: string }[]>(
      app,
      staff.cookie,
      "models/list",
      {},
      companySpaceId,
    );
    expect(catalog.some((entry) => entry.provider === "openrouter")).toBe(true);
    expect(
      await status(app, staff.cookie, "models/clearCompanyConnection", {}, companySpaceId),
    ).toBe(403);
    await rpc(app, owner.cookie, "models/clearCompanyConnection", {});
    expect(await rpc(app, staff.cookie, "models/companyConnection", {}, companySpaceId)).toBeNull();
    const after = await rpc<Me>(app, staff.cookie, "me", {}, companySpaceId);
    expect(after.defaultProvider).toBe(before.defaultProvider);
    expect(
      await db.secret.count({ where: { spaceId: companySpaceId, kind: "company-model" } }),
    ).toBe(0);
  });
});
