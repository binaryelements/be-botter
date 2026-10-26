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
  let rows: Array<{ id: string; userId: string; kind: string; ciphertext: string }> = [];
  let seq = 0;
  const secrets = {
    put: vi.fn(async (plaintext: string) => {
      const id = `secret-${++seq}`;
      values.set(`ref-${id}`, plaintext);
      return { id, ciphertext: `ref-${id}` };
    }),
    load: vi.fn(async (ref: string) => values.get(ref) ?? ""),
  };
  const prisma = {
    secret: {
      findFirst: vi.fn(async ({ where }: { where: { userId: string; kind: string } }) =>
        rows.findLast((row) => row.userId === where.userId && row.kind === where.kind),
      ),
      create: vi.fn(async ({ data }: { data: (typeof rows)[number] }) => {
        rows.push(data);
        return data;
      }),
      deleteMany: vi.fn(async ({ where }: { where: { userId: string; id: { not: string } } }) => {
        rows = rows.filter((row) => row.userId !== where.userId || row.id === where.id.not);
        return { count: 0 };
      }),
    },
  };
  const deps = {
    prisma: prisma as unknown as Pick<PrismaClient, "secret">,
    secrets: secrets as unknown as Pick<SecretStore, "put" | "load">,
  };
  const stored = () =>
    rows.map((row) => ({ ...row, value: JSON.parse(values.get(row.ciphertext) ?? "null") }));
  return { deps, prisma, secrets, stored, ready: initial && saveSsoToken(deps, "u1", initial) };
}

describe("saveSsoToken", () => {
  it("keeps one account-level sso-token secret per person, sealed by the secret store", async () => {
    const { deps, stored } = memoryStore();
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
    const refresh = createSsoTokenRefresher({
      ...store.deps,
      oidc,
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => now,
    });
    return { ...store, refresh, fetch, advance: (ms: number) => (now += ms) };
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

  it("checks a person at most once every 5 minutes", async () => {
    const { refresh, fetch, advance } = await setup(
      { accessToken: "a", refreshToken: "r", expiresAt: NOW },
      () => Response.json({ error: "invalid_grant" }, { status: 400 }),
    );
    await refresh("u1");
    await refresh("u1");
    advance(4 * MINUTE);
    await refresh("u1");
    expect(tokenCalls(fetch)).toHaveLength(1);
    advance(MINUTE);
    await refresh("u1");
    expect(tokenCalls(fetch)).toHaveLength(2);
  });

  it("never throws and keeps the stored token on a failed refresh", async () => {
    const failed = await setup({ accessToken: "a", refreshToken: "r", expiresAt: NOW }, () => {
      throw new Error("network r");
    });
    await expect(failed.refresh("u1")).resolves.toBeUndefined();
    expect(failed.stored().map((row) => row.value.accessToken)).toEqual(["a"]);
  });
});
