import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioConnector, FakeComposioClient } from "@rakazo/adapters";
import { asSystem, joinSpace, runAsSystem } from "@rakazo/db";
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

async function raw(
  app: App,
  cookie: string,
  procedure: string,
  body: unknown = {},
  spaceId?: string,
) {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: ORIGIN,
      ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
    },
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

describePostgres("invitations over the API (PostgreSQL)", () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-invite-"));
  let handles: AppHandles;
  let app: App;
  let db: AppHandles["prisma"];
  let superadmin: { cookie: string; userId: string };
  let owner: { cookie: string; userId: string };
  let member: { cookie: string; userId: string };
  let stranger: { cookie: string; userId: string };
  let companySpaceId: string;
  let departmentId: string;
  let saved: Record<string, unknown> | null;
  const email = `New.Person-${stamp}@acme.test`;

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
    superadmin = await signup(app, `inv-admin-${stamp}@rakazo.test`, "Admin");
    owner = await signup(app, `inv-owner-${stamp}@rakazo.test`, "Owner");
    member = await signup(app, `inv-member-${stamp}@rakazo.test`, "Member");
    stranger = await signup(app, `inv-other-${stamp}@rakazo.test`, "Other");
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
    await raw(app, superadmin.cookie, "setup/createCompany", { name: `Acme ${stamp}` });
    const setup = await raw(app, superadmin.cookie, "setup/get");
    companySpaceId = setup.json.companySpaceId;
    const added = await raw(app, superadmin.cookie, "setup/addDepartment", {
      name: "Accounts",
      instructions: "You help {department}.",
    });
    departmentId = added.json.departmentId;
    await runAsSystem("join the company", async () => {
      await joinSpace(handles.prisma, companySpaceId, owner.userId, "owner");
      await joinSpace(handles.prisma, companySpaceId, member.userId, "member");
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

  const ownerCall = (procedure: string, body: unknown = {}) =>
    raw(app, owner.cookie, procedure, body, companySpaceId);

  it("keeps people, invitations and the sign-in switch to company owners and the superadmin", async () => {
    const calls: [string, unknown][] = [
      ["invitations/list", {}],
      ["invitations/create", { email: "x@acme.test", departments: [] }],
      ["invitations/revoke", { invitationId: "nope" }],
      ["company/signInMode/get", {}],
      ["company/signInMode/set", { mode: "organisation" }],
    ];
    for (const [procedure, body] of calls) {
      expect(
        (await raw(app, member.cookie, procedure, body, companySpaceId)).status,
        procedure,
      ).toBe(403);
      // Owning their own Space is not enough.
      expect((await raw(app, stranger.cookie, procedure, body)).status, procedure).toBe(403);
    }
  });

  it("creates, lists, rejects a duplicate and revokes", async () => {
    const created = await ownerCall("invitations/create", {
      email,
      departments: [{ departmentId, role: "head" }],
    });
    expect(created.status).toBe(200);
    expect(created.json).toMatchObject({
      invitation: {
        email: email.toLowerCase(),
        departments: [{ departmentId, role: "head" }],
        acceptedAt: null,
      },
      emailed: false,
    });
    expect(created.json.signInUrl).toMatch(/\/sign-in$/);
    const listed = await ownerCall("invitations/list");
    expect(listed.json).toEqual([created.json.invitation]);
    const dup = await ownerCall("invitations/create", {
      email: email.toUpperCase(),
      departments: [],
    });
    expect(dup.status).toBe(409);
    const foreign = await ownerCall("invitations/create", {
      email: `other-${stamp}@acme.test`,
      departments: [{ departmentId: "not-ours", role: "member" }],
    });
    expect(foreign.status).toBe(400);
    expect(
      (await ownerCall("invitations/revoke", { invitationId: created.json.invitation.id })).status,
    ).toBe(200);
    expect((await ownerCall("invitations/list")).json).toEqual([]);
  });

  it("does not revoke an accepted invitation", async () => {
    const row = await db.spaceInvitation.create({
      data: {
        spaceId: companySpaceId,
        email: `done-${stamp}@acme.test`,
        createdByUserId: owner.userId,
        acceptedAt: new Date(),
        acceptedUserId: member.userId,
      },
    });
    expect((await ownerCall("invitations/revoke", { invitationId: row.id })).status).toBe(404);
  });

  it("switches the sign-in mode and reports readiness", async () => {
    expect((await ownerCall("company/signInMode/get")).json).toMatchObject({
      mode: "invited",
      ready: false,
      departments: [{ id: departmentId, name: "Accounts" }],
    });
    expect((await ownerCall("company/signInMode/set", { mode: "organisation" })).status).toBe(200);
    expect((await raw(app, superadmin.cookie, "company/signInMode/get")).json.mode).toBe(
      "organisation",
    );
  });
});
