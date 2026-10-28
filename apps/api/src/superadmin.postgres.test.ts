import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { createApp } from "./app.js";

type AppHandles = Awaited<ReturnType<typeof createApp>>;

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

const ORIGIN = "http://127.0.0.1:5173";
const KEY = "f".repeat(64);
const json = { "content-type": "application/json", origin: ORIGIN };
const signInWith = (app: AppHandles["app"], key: string) =>
  app.request("/api/auth/sign-in/admin-key", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ key }),
  });

describePostgres("superadmin admin-key sign-in (PostgreSQL)", () => {
  const dirs = [
    mkdtempSync(path.join(tmpdir(), "rakazo-admin-key-")),
    mkdtempSync(path.join(tmpdir(), "rakazo-admin-key-")),
  ];
  const options = (dataDir: string) => ({
    databaseUrl: databaseUrl!,
    dataDir,
    sandboxProvider: "fake" as const,
    agentRuntime: "scripted" as const,
    wakeupDriver: "memory" as const,
    signupsEnabled: "true",
  });
  let handles: AppHandles;
  let keyless: AppHandles;
  let db: AppHandles["prisma"];
  let saved: Record<string, unknown> | null;

  beforeAll(async () => {
    const { createApp } = await import("./app.js");
    keyless = await createApp(options(dirs[1]));
    db = asSystem(keyless.prisma);
    // Read before the keyed app's start-up makes the superadmin the deployment owner.
    saved = await db.deploymentSettings.findUnique({ where: { id: "default" } });
    handles = await createApp({ ...options(dirs[0]), superadminKey: KEY });
  }, 180_000);

  afterAll(async () => {
    // Start-up made the superadmin the deployment owner; put the previous owner back.
    if (saved) {
      const { id: _id, ...rest } = saved as { id: string };
      await db.deploymentSettings.update({ where: { id: "default" }, data: rest as never });
    } else {
      await db.deploymentSettings.deleteMany({ where: { id: "default" } });
    }
    await handles?.stop();
    await keyless?.stop();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a wrong, empty or padded key with 403 and records the failure", async () => {
    const failures = () =>
      db.securityEvent.count({
        where: {
          type: "auth.sign_in.failed",
          metadata: { path: ["path"], equals: "/sign-in/admin-key" },
        },
      });
    const before = await failures();
    for (const key of ["", ` ${KEY}`, `${KEY.slice(1)}0`]) {
      const r = await signInWith(handles.app, key);
      expect(r.status, key).toBe(403);
      expect(((await r.json()) as { code?: string }).code).toBe("WRONG_ADMIN_KEY");
    }
    expect((await failures()) - before).toBe(3);
  });

  it("signs the superadmin in with the right key", async () => {
    const r = await signInWith(handles.app, KEY);
    expect(r.status).toBe(200);
    const cookie = r.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const me = await handles.app.request("/rpc/me", {
      method: "POST",
      headers: { ...json, cookie },
      body: JSON.stringify({ json: {} }),
    });
    expect(((await me.json()) as { json: unknown }).json).toMatchObject({
      isDeploymentOwner: true,
      name: "Binary Elements",
    });
  });

  it("has no key endpoint when no key is configured", async () => {
    expect((await signInWith(keyless.app, KEY)).status).toBe(404);
  });

  it("refuses every other sign-in method for the superadmin", async () => {
    // The email-code routes are not registered here (no email provider); the same guard covers them.
    const email = "SuperAdmin@botter.invalid";
    for (const [route, body] of [
      ["sign-in/email", { email, password: "password12" }],
      ["sign-up/email", { email, password: "password12", name: "x" }],
      ["request-password-reset", { email }],
    ] as const) {
      const r = await handles.app.request(`/api/auth/${route}`, {
        method: "POST",
        headers: json,
        body: JSON.stringify(body),
      });
      expect(r.status, route).toBe(403);
      expect(((await r.json()) as { code?: string }).code, route).toBe("NOT_INVITED");
    }
  });

  it("turns a password newcomer away before handover but keeps the superadmin signed in", async () => {
    await db.deploymentSettings.update({
      where: { id: "default" },
      data: { companyReadyAt: null },
    });
    const email = `new-${Date.now()}@rakazo.test`;
    const r = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email, password: "password12", name: "New" }),
    });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { code?: string }).code).toBe("NOT_INVITED");
    await db.user.deleteMany({ where: { email } });
    expect((await signInWith(handles.app, KEY)).status).toBe(200);
  });
});
