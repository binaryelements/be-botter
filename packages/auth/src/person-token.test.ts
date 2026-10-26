import type { SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { symmetricEncrypt } from "better-auth/crypto";
import { describe, expect, it, vi } from "vitest";
import type { OidcConfig } from "./oidc.js";
import type { SsoToken } from "./person-token.js";
import {
  createPersonTokenSource,
  createSsoTokenRefresher,
  saveSsoToken,
  ssoTokenFromAccount,
} from "./person-token.js";

const issuer = "https://identity.example.test";
const oidc: OidcConfig = {
  issuer,
  clientId: "client-id",
  clientSecret: "client-secret",
  name: "SSO",
  scopes: ["offline_access", "https://graph.example.test/Mail.Read", "profile"],
  allowSignupBypass: false,
};
const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

/** A secret table and store in memory: put seals nothing, the row holds a ref to the value. */
function memoryStore(initial?: SsoToken) {
  const values = new Map<string, string>();
  type Row = { id: string; userId: string; kind: string; ciphertext: string; createdAt: Date };
  let rows: Row[] = [];
  let seq = 0;
  const secrets = {
    put: vi.fn(async (plaintext: string) => {
      const id = `secret-${++seq}`;
      values.set(`ref-${id}`, plaintext);
      return { id, ciphertext: `ref-${id}` };
    }),
    load: vi.fn(async (ref: string) => values.get(ref) ?? ""),
    delete: vi.fn(async (ref: string) => {
      values.delete(ref);
    }),
  };
  let created = 0;
  const prisma = {
    secret: {
      findMany: vi.fn(
        async ({ where }: { where: { kind: string; userId?: string; createdAt?: { lt: Date } } }) =>
          rows.filter(
            (row) =>
              row.kind === where.kind &&
              (!where.userId || row.userId === where.userId) &&
              (!where.createdAt || row.createdAt < where.createdAt.lt),
          ),
      ),
      findFirst: vi.fn(async ({ where }: { where: { userId: string; kind: string } }) =>
        rows.findLast((row) => row.userId === where.userId && row.kind === where.kind),
      ),
      create: vi.fn(async ({ data }: { data: Omit<Row, "createdAt"> }) => {
        const row = { ...data, createdAt: new Date(NOW + ++created) };
        rows.push(row);
        return row;
      }),
      deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        const before = rows.length;
        rows = rows.filter((row) => !where.id.in.includes(row.id));
        return { count: before - rows.length };
      }),
    },
  };
  const deps = {
    prisma: prisma as unknown as Pick<PrismaClient, "secret">,
    secrets: secrets as unknown as Pick<SecretStore, "put" | "load" | "delete">,
  };
  const stored = () =>
    rows.map(({ createdAt: _, ...row }) => ({
      ...row,
      value: JSON.parse(values.get(row.ciphertext) ?? "null"),
    }));
  return {
    deps,
    prisma,
    secrets,
    values,
    stored,
    ready: initial && saveSsoToken(deps, "u1", initial),
  };
}

describe("saveSsoToken", () => {
  it("keeps one account-level sso-token secret per person, sealed by the secret store", async () => {
    const { deps, stored, secrets, values } = memoryStore();
    await saveSsoToken(deps, "u1", { accessToken: "a1", expiresAt: NOW });
    await saveSsoToken(deps, "u1", { accessToken: "a2", expiresAt: NOW, refreshToken: "r2" });
    expect(stored()).toEqual([
      {
        id: "secret-2",
        userId: "u1",
        spaceId: null,
        kind: "sso-token",
        ciphertext: "ref-secret-2",
        value: { accessToken: "a2", expiresAt: NOW, refreshToken: "r2" },
      },
    ]);
    // The replaced value leaves the secret store too, not just the table.
    expect(secrets.delete).toHaveBeenCalledWith("ref-secret-1", { recordId: "secret-1" });
    expect([...values.keys()]).toEqual(["ref-secret-2"]);
  });

  it("still saves when the secret store cannot delete the old value", async () => {
    const { deps, stored, secrets } = memoryStore();
    secrets.delete.mockRejectedValue(new Error("store down"));
    await saveSsoToken(deps, "u1", { accessToken: "a1", expiresAt: NOW });
    await saveSsoToken(deps, "u1", { accessToken: "a2", expiresAt: NOW });
    expect(stored().map((row) => row.value.accessToken)).toEqual(["a2"]);
  });

  it("keeps a token when two saves for a person interleave", async () => {
    const { deps, prisma, stored } = memoryStore();
    // Both rows exist before either save removes the ones it replaces.
    const create = prisma.secret.create.getMockImplementation()!;
    let release!: () => void;
    const bothCreated = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pending = 2;
    prisma.secret.create.mockImplementation(async (args) => {
      const row = await create(args);
      if (--pending === 0) release();
      await bothCreated;
      return row;
    });
    await Promise.all([
      saveSsoToken(deps, "u1", { accessToken: "a", expiresAt: NOW }),
      saveSsoToken(deps, "u1", { accessToken: "b", expiresAt: NOW }),
    ]);
    expect(stored().map((row) => row.value.accessToken)).toEqual(["b"]);
  });
});

describe("ssoTokenFromAccount", () => {
  it("decrypts what Better Auth stored for the sign-in", async () => {
    const key = "offline-test-secret-with-at-least-32-characters";
    expect(
      await ssoTokenFromAccount(key, {
        accessToken: await symmetricEncrypt({ key, data: "access" }),
        refreshToken: await symmetricEncrypt({ key, data: "refresh" }),
        accessTokenExpiresAt: new Date(NOW),
      }),
    ).toEqual({ accessToken: "access", refreshToken: "refresh", expiresAt: NOW });
    expect(await ssoTokenFromAccount(key, { accessToken: null })).toBeNull();
  });
});

describe("person token source", () => {
  it("returns the stored access token while more than a minute remains", async () => {
    const store = memoryStore({ accessToken: "a", refreshToken: "r", expiresAt: NOW + 2 * MINUTE });
    await store.ready;
    const source = createPersonTokenSource({ ...store.deps, now: () => NOW });
    expect(await source("u1")).toEqual({ accessToken: "a", expiresAt: NOW + 2 * MINUTE });
  });

  it("returns null for a missing, expiring or unreadable token", async () => {
    const empty = memoryStore();
    expect(await createPersonTokenSource({ ...empty.deps, now: () => NOW })("u1")).toBeNull();
    const expiring = memoryStore({ accessToken: "a", expiresAt: NOW + MINUTE });
    await expiring.ready;
    expect(await createPersonTokenSource({ ...expiring.deps, now: () => NOW })("u1")).toBeNull();
    const broken = memoryStore({ accessToken: "a", expiresAt: NOW + 10 * MINUTE });
    await broken.ready;
    broken.secrets.load.mockRejectedValueOnce(new Error("store down"));
    expect(await createPersonTokenSource({ ...broken.deps, now: () => NOW })("u1")).toBeNull();
  });
});

describe("SSO token refresher", () => {
  async function setup(
    token: SsoToken,
    respond: () => Response = () => Response.json({ access_token: "new", expires_in: 3600 }),
  ) {
    const store = memoryStore(token);
    await store.ready;
    let now = NOW;
    const fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
      String(url) === `${issuer}/.well-known/openid-configuration`
        ? Response.json({ token_endpoint: `${issuer}/token` })
        : respond(),
    );
    const { refresh, renewDue } = createSsoTokenRefresher({
      ...store.deps,
      oidc,
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => now,
    });
    return { ...store, refresh, renewDue, fetch, advance: (ms: number) => (now += ms) };
  }
  const tokenCalls = (fetch: { mock: { calls: unknown[][] } }) =>
    fetch.mock.calls.filter(([url]) => String(url) === `${issuer}/token`);

  it("refreshes a token expiring within 45 minutes and stores the rotated one", async () => {
    const { refresh, fetch, stored } = await setup(
      { accessToken: "old", refreshToken: "old-refresh", expiresAt: NOW + 40 * MINUTE },
      () => Response.json({ access_token: "new", refresh_token: "new-refresh", expires_in: 3600 }),
    );
    await refresh("u1");
    const init = tokenCalls(fetch)[0]?.[1] as RequestInit;
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "old-refresh",
      client_id: "client-id",
      client_secret: "client-secret",
      scope: "openid email profile offline_access https://graph.example.test/Mail.Read",
    });
    expect(stored().map((row) => row.value)).toEqual([
      { accessToken: "new", refreshToken: "new-refresh", expiresAt: NOW + 3_600_000 },
    ]);
  });

  it("keeps the refresh token when none is rotated", async () => {
    const { refresh, stored } = await setup({
      accessToken: "old",
      refreshToken: "kept",
      expiresAt: NOW,
    });
    await refresh("u1");
    expect(stored().map((row) => row.value)).toEqual([
      { accessToken: "new", refreshToken: "kept", expiresAt: NOW + 3_600_000 },
    ]);
  });

  it("leaves a token with more than 45 minutes alone", async () => {
    const { refresh, fetch } = await setup({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: NOW + 50 * MINUTE,
    });
    await refresh("u1");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks a person on their requests at most once every 5 minutes", async () => {
    const { refresh, secrets, advance } = await setup({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: NOW + 50 * MINUTE,
    });
    secrets.load.mockClear();
    await refresh("u1");
    await refresh("u1");
    advance(4 * MINUTE);
    await refresh("u1");
    expect(secrets.load).toHaveBeenCalledTimes(1);
    advance(MINUTE);
    await refresh("u1");
    expect(secrets.load).toHaveBeenCalledTimes(2);
  });

  it("never throws and keeps the stored token on a failed refresh", async () => {
    const failed = await setup({ accessToken: "a", refreshToken: "r", expiresAt: NOW }, () => {
      throw new Error("network r");
    });
    await expect(failed.refresh("u1")).resolves.toBeUndefined();
    expect(failed.stored().map((row) => row.value.accessToken)).toEqual(["a"]);
  });

  it("renews due tokens in the background and leaves fresh ones alone", async () => {
    const { deps, renewDue, fetch, stored } = await setup(
      { accessToken: "due", refreshToken: "due-refresh", expiresAt: NOW + 30 * MINUTE },
      () => Response.json({ access_token: "renewed", expires_in: 3600 }),
    );
    await saveSsoToken(deps, "u2", {
      accessToken: "fresh",
      refreshToken: "fresh-refresh",
      expiresAt: NOW + 120 * MINUTE,
    });
    const log = vi.spyOn(console, "log");
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    try {
      expect(await renewDue()).toBe(1);
      const bodies = tokenCalls(fetch).map(([, init]) =>
        new URLSearchParams(String((init as RequestInit).body)).get("refresh_token"),
      );
      expect(bodies).toEqual(["due-refresh"]);
      expect(
        Object.fromEntries(stored().map((row) => [row.userId, row.value.accessToken])),
      ).toEqual({ u1: "renewed", u2: "fresh" });
      expect([...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]).toEqual([]);
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("tries a person whose refresh failed at most once an hour", async () => {
    const { renewDue, refresh, fetch, advance } = await setup(
      { accessToken: "a", refreshToken: "revoked", expiresAt: NOW + 30 * MINUTE },
      () => Response.json({ error: "invalid_grant" }, { status: 400 }),
    );
    await renewDue();
    expect(tokenCalls(fetch)).toHaveLength(1);
    for (let i = 0; i < 5; i += 1) {
      advance(10 * MINUTE);
      await renewDue();
      await refresh("u1");
    }
    expect(tokenCalls(fetch)).toHaveLength(1);
    advance(10 * MINUTE);
    await renewDue();
    expect(tokenCalls(fetch)).toHaveLength(2);
  });

  it("keeps renewing other people when one cannot be read", async () => {
    const { deps, secrets, renewDue, stored } = await setup({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: NOW,
    });
    await saveSsoToken(deps, "u2", { accessToken: "b", refreshToken: "r2", expiresAt: NOW });
    secrets.load.mockRejectedValueOnce(new Error("store down"));
    expect(await renewDue()).toBe(1);
    expect(
      stored()
        .map((row) => row.value.accessToken)
        .sort(),
    ).toEqual(["a", "new"]);
  });
});
