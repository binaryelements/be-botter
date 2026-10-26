import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioConnector, FakeComposioClient } from "@rakazo/adapters";
import type { McpServer, Me } from "@rakazo/contracts";
import { asSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { createApp } from "./app.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
type AppHandles = Awaited<ReturnType<typeof createApp>>;
type User = { cookie: string; userId: string };

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

async function signup(app: App, email: string, name: string): Promise<User> {
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

const remoteServer = (slug: string, extra: Record<string, unknown> = {}) => ({
  transport: "streamable_http",
  slug,
  name: slug,
  endpoint: "https://mcp.example.test/mcp",
  // Disabled: nothing is probed in the background.
  enabled: false,
  ...extra,
});

/** Every procedure that adds access, with input that passes its schema. */
const GUARDED: [string, unknown][] = [
  ["mcp/servers/create", remoteServer("guarded")],
  ["mcp/servers/update", { id: "missing", secret: "fake-token" }],
  ["mcp/servers/remove", { id: "missing" }],
  ["mcp/assignments/approve", { botId: "missing", serverId: "missing" }],
  ["mcp/assignments/replace", { botId: "missing", assignments: [] }],
  ["mcp/oauth/begin", { serverId: "missing", redirectUri: `${ORIGIN}/mcp/oauth/callback` }],
  ["mcp/oauth/complete", { sessionId: "missing", code: "code", state: "state" }],
  ["connections/begin", { provider: "missing", displayName: "Missing" }],
  ["connections/complete", { connectionId: "missing" }],
  ["capabilities/install", { kind: "api", name: "Missing", source: "https://api.example.test" }],
  ["agentSecrets/put", { name: "FAKE_TOKEN", value: "fake-value" }],
  ["agentSecrets/remove", { id: "missing" }],
  [
    "botSecrets/put",
    {
      botId: "missing",
      destination: { name: "fake", auth: { type: "command" } },
      value: "fake-value",
    },
  ],
  ["botSecrets/remove", { botId: "missing", name: "fake" }],
  ["models/connect", { provider: "missing-provider", apiKey: "fake-key-000000" }],
  ["models/setCompanyConnection", { provider: "missing-provider", apiKey: "fake-key-000000" }],
  ["models/beginOAuth", { provider: "missing-provider" }],
  ["models/finishOAuth", { loginId: "missing" }],
  ["memory/connectProvider", { provider: "missing", settings: {}, credentials: {} }],
  ["voice/connect", { provider: "missing", apiKey: "fake-key-000000" }],
  ["messaging/link/start", { botId: "missing" }],
  ["messaging/channels/respond", { membershipId: "missing", accept: true }],
  ["messaging/connections/respond", { connectionId: "missing", accept: true }],
  ["spaces/create", { name: "Side project" }],
];

describePostgres("company connections and the admin-only switch (PostgreSQL)", () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-company-connections-"));
  let handles: AppHandles;
  let app: App;
  let db: AppHandles["prisma"];
  let deployer: User;
  let owner: User;
  let staff: User;
  const staffEmail = `connections-staff-${stamp}@rakazo.test`;
  let companySpaceId: string;
  let personalSpaceId: string;
  let salesId: string;
  let outsideDepartmentId: string;
  let previousSettings: {
    ownerUserId: string | null;
    companySpaceId: string | null;
    connectionsAdminOnly: boolean;
  } | null;

  const setSwitch = (on: boolean) =>
    rpc(app, deployer.cookie, "deployment/update", { connectionsAdminOnly: on });

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
      remoteConnectors: { resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
    });
    app = handles.app;
    db = asSystem(handles.prisma);
    deployer = await signup(app, `connections-deployer-${stamp}@rakazo.test`, "Deployer");
    owner = await signup(app, `connections-owner-${stamp}@rakazo.test`, "Owner");
    staff = await signup(app, staffEmail, "Staff");
    companySpaceId = (await rpc<Me>(app, owner.cookie, "me")).spaceId;
    personalSpaceId = (await rpc<Me>(app, staff.cookie, "me")).spaceId;
    previousSettings = await db.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { ownerUserId: true, companySpaceId: true, connectionsAdminOnly: true },
    });
    // The shared test database already has a deployment owner; this suite borrows the role.
    await db.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", ownerUserId: deployer.userId, companySpaceId },
      update: { ownerUserId: deployer.userId, companySpaceId, connectionsAdminOnly: false },
    });
    const sales = await rpc<{ id: string }>(app, owner.cookie, "departments/create", {
      name: "Sales",
    });
    salesId = sales.id;
    await rpc(app, owner.cookie, "departments/setUsers", {
      departmentId: salesId,
      users: [{ email: staffEmail, role: "member" }],
    });
    outsideDepartmentId = (
      await rpc<{ id: string }>(app, staff.cookie, "departments/create", { name: "Mine" })
    ).id;
  });

  afterAll(async () => {
    if (db) {
      await db.deploymentSettings.update({
        where: { id: "default" },
        data: previousSettings ?? { ownerUserId: null, companySpaceId: null },
      });
    }
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("lets an owner share a server that signs in as each person, limited to a department", async () => {
    const server = await rpc<McpServer>(
      app,
      owner.cookie,
      "mcp/servers/create",
      remoteServer("crm", { shared: true, signIn: "person", departmentIds: [salesId] }),
    );
    expect(server).toMatchObject({ shared: true, signIn: "person", departmentIds: [salesId] });
    expect(await db.mcpServerDepartment.findMany({ where: { serverId: server.id } })).toMatchObject(
      [{ departmentId: salesId }],
    );

    const updated = await rpc<McpServer>(app, owner.cookie, "mcp/servers/update", {
      id: server.id,
      config: remoteServer("crm", { departmentIds: [] }),
    });
    // Omitted fields keep their value; an empty list means the whole company.
    expect(updated).toMatchObject({ shared: true, signIn: "person", departmentIds: [] });

    // The probe signs in as the admin who runs it; a password admin has no SSO token.
    const tested = await rpc<McpServer>(app, owner.cookie, "mcp/servers/test", { id: server.id });
    expect(tested.health).toMatchObject({
      status: "error",
      message: expect.stringContaining("sign in to BE Botter again to use it"),
    });

    // Its credential is a static token or the person's: never an OAuth flow.
    expect(
      await status(app, owner.cookie, "mcp/oauth/begin", {
        serverId: server.id,
        redirectUri: `${ORIGIN}/mcp/oauth/callback`,
      }),
    ).toBe(400);

    // Bots reach it through departments, not assignments.
    const bot = await rpc<{ id: string }>(app, owner.cookie, "bots/create", { name: "Helper" });
    expect(
      await status(app, owner.cookie, "mcp/assignments/replace", {
        botId: bot.id,
        assignments: [{ serverId: server.id }],
      }),
    ).toBe(400);
    // Approving without a card's thread always assigns, so this reaches the shared check,
    // which only looks at enabled servers.
    await db.mcpServer.update({ where: { id: server.id }, data: { enabled: true } });
    expect(
      await status(app, owner.cookie, "mcp/assignments/approve", {
        botId: bot.id,
        serverId: server.id,
      }),
    ).toBe(400);
    expect(await db.botMcpServer.count({ where: { serverId: server.id } })).toBe(0);
    await db.mcpServer.update({ where: { id: server.id }, data: { enabled: false } });

    // Members never see it, or its credential.
    const listed = await rpc<McpServer[]>(
      app,
      staff.cookie,
      "mcp/servers/list",
      {},
      companySpaceId,
    );
    expect(listed.some((row) => row.id === server.id)).toBe(false);
  });

  it("rejects invalid company connections", async () => {
    // Only owners, and only in the company space.
    expect(
      await status(
        app,
        staff.cookie,
        "mcp/servers/create",
        remoteServer("staff-shared", { shared: true }),
        companySpaceId,
      ),
    ).toBe(403);
    expect(
      await status(
        app,
        staff.cookie,
        "mcp/servers/create",
        remoteServer("personal-shared", { shared: true }),
        personalSpaceId,
      ),
    ).toBe(403);
    // Departments outside the company space.
    expect(
      await status(
        app,
        owner.cookie,
        "mcp/servers/create",
        remoteServer("outside", { shared: true, departmentIds: [outsideDepartmentId] }),
      ),
    ).toBe(400);
    // A launched process cannot carry each person's token.
    expect(
      await status(app, owner.cookie, "mcp/servers/create", {
        transport: "stdio",
        slug: "local",
        name: "Local",
        command: "npx",
        enabled: false,
        shared: true,
        signIn: "person",
      }),
    ).toBe(400);
    // Each person signs in with their own token, so no stored credential rides along.
    for (const credential of [
      { secret: "fake-admin-token" },
      { headers: { "X-Api-Key": "fake-admin-key" } },
    ]) {
      expect(
        await status(
          app,
          owner.cookie,
          "mcp/servers/create",
          remoteServer("person-credential", { shared: true, signIn: "person", ...credential }),
        ),
      ).toBe(400);
    }
    // No OAuth client on a shared server.
    expect(
      await status(
        app,
        owner.cookie,
        "mcp/servers/create",
        remoteServer("oauth-shared", { shared: true, oauthClient: { clientId: "fake-client" } }),
      ),
    ).toBe(400);
    // Sign-in mode and departments only mean something on a shared server.
    expect(
      await status(
        app,
        owner.cookie,
        "mcp/servers/create",
        remoteServer("private-person", { signIn: "person" }),
      ),
    ).toBe(400);
    expect(
      await status(
        app,
        owner.cookie,
        "mcp/servers/create",
        remoteServer("private-departments", { departmentIds: [salesId] }),
      ),
    ).toBe(400);
  });

  it("stops everyone but admins adding access while the switch is on", async () => {
    const settings = await setSwitch(true);
    expect(settings).toMatchObject({ connectionsAdminOnly: true });
    expect(
      await status(app, staff.cookie, "deployment/update", { connectionsAdminOnly: false }),
    ).toBe(403);

    expect((await rpc<Me>(app, staff.cookie, "me", {}, companySpaceId)).canManageConnections).toBe(
      false,
    );
    expect((await rpc<Me>(app, staff.cookie, "me", {}, personalSpaceId)).canManageConnections).toBe(
      false,
    );
    expect((await rpc<Me>(app, owner.cookie, "me")).canManageConnections).toBe(true);
    expect((await rpc<Me>(app, deployer.cookie, "me")).canManageConnections).toBe(true);
    expect((await rpc<Me>(app, owner.cookie, "me")).canShareConnections).toBe(true);
    expect((await rpc<Me>(app, staff.cookie, "me", {}, companySpaceId)).canShareConnections).toBe(
      false,
    );
    expect((await rpc<Me>(app, staff.cookie, "me", {}, personalSpaceId)).canShareConnections).toBe(
      false,
    );

    for (const [procedure, body] of GUARDED) {
      for (const spaceId of [companySpaceId, personalSpaceId]) {
        expect({
          procedure,
          spaceId,
          status: await status(app, staff.cookie, procedure, body, spaceId),
        }).toEqual({
          procedure,
          spaceId,
          status: 403,
        });
      }
    }

    // Owners of the company space still add connections; only the deployment owner adds spaces.
    await rpc(app, owner.cookie, "mcp/servers/create", remoteServer("owner-private"));
    expect(await status(app, owner.cookie, "spaces/create", { name: "Owner side" })).toBe(403);
    const created = await rpc<{ id: string }>(app, deployer.cookie, "spaces/create", {
      name: "Deployer side",
    });
    expect(created.id).toBeTruthy();
  });

  it("lets members add their own access while the switch is off", async () => {
    expect(await setSwitch(false)).toMatchObject({ connectionsAdminOnly: false });
    expect((await rpc<Me>(app, staff.cookie, "me", {}, personalSpaceId)).canManageConnections).toBe(
      true,
    );
    for (const [procedure, body] of GUARDED) {
      expect({
        procedure,
        status: await status(app, staff.cookie, procedure, body, personalSpaceId),
      }).not.toEqual({ procedure, status: 403 });
    }
    await rpc(app, staff.cookie, "mcp/servers/create", remoteServer("staff-own"), companySpaceId);
    await rpc(app, staff.cookie, "agentSecrets/put", { name: "FAKE_KEY", value: "fake-value" });
  });
});
