import type { PrismaClient } from "@rakazo/db";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { describe, expect, it, vi } from "vitest";
import type { OidcConfig } from "./oidc.js";
import { createPersonTokenSource } from "./person-token.js";
import type { TokenKey } from "./token-storage.js";

const key: TokenKey = "offline-test-secret-with-at-least-32-characters";
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

async function setup(
  account: { accessToken?: string; refreshToken?: string | null; exp?: number } | null,
  token: () => Response = () => Response.json({ access_token: "new-access", expires_in: 3600 }),
) {
  const row = account && {
    id: "acc1",
    accessToken: await symmetricEncrypt({ key, data: account.accessToken ?? "old-access" }),
    refreshToken:
      account.refreshToken === null
        ? null
        : await symmetricEncrypt({ key, data: account.refreshToken ?? "old-refresh" }),
    accessTokenExpiresAt: new Date(account.exp ?? NOW + 3_600_000),
  };
  const findFirst = vi.fn(async () => row);
  const update = vi.fn(async () => ({}));
  const fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
    String(url) === `${issuer}/.well-known/openid-configuration`
      ? Response.json({ token_endpoint: `${issuer}/token` })
      : token(),
  );
  const source = createPersonTokenSource({
    prisma: { account: { findFirst, update } } as unknown as Pick<PrismaClient, "account">,
    key,
    oidc,
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => NOW,
  });
  return { source, findFirst, update, fetch };
}

describe("person token source", () => {
  it("returns the stored token while more than 5 minutes remain", async () => {
    const { source, findFirst, fetch } = await setup({ exp: NOW + 6 * 60_000 });
    expect(await source("u1")).toEqual({ accessToken: "old-access", expiresAt: NOW + 6 * 60_000 });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u1", providerId: "oidc" },
        orderBy: { createdAt: "desc" },
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes under 5 minutes, stores encrypted rotated tokens and returns the new one", async () => {
    const { source, update, fetch } = await setup({ exp: NOW + 4 * 60_000 }, () =>
      Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
    );
    expect(await source("u1")).toEqual({ accessToken: "new-access", expiresAt: NOW + 3_600_000 });
    const init = fetch.mock.calls[1]?.[1] as RequestInit;
    expect(fetch.mock.calls[1]?.[0]).toBe(`${issuer}/token`);
    const body = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "old-refresh",
      client_id: "client-id",
      client_secret: "client-secret",
      scope: "openid email profile offline_access https://graph.example.test/Mail.Read",
    });
    const call = update.mock.calls[0] as unknown as [
      { where: { id: string }; data: Record<string, unknown> },
    ];
    expect(call[0].where).toEqual({ id: "acc1" });
    const { data } = call[0];
    expect(await symmetricDecrypt({ key, data: data.accessToken as string })).toBe("new-access");
    expect(await symmetricDecrypt({ key, data: data.refreshToken as string })).toBe("new-refresh");
    expect(data.accessTokenExpiresAt).toEqual(new Date(NOW + 3_600_000));
  });

  it("keeps the refresh token when none is rotated and fetches discovery once", async () => {
    const { source, update, fetch } = await setup({ exp: NOW });
    await source("u1");
    await source("u1");
    const data = (update.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).not.toHaveProperty("refreshToken");
    expect(
      fetch.mock.calls.filter(([u]) => String(u).endsWith("/openid-configuration")),
    ).toHaveLength(1);
  });

  it("returns null without throwing for missing account, refresh token or refresh error", async () => {
    expect(await (await setup(null)).source("u1")).toBeNull();
    expect(await (await setup({ exp: NOW, refreshToken: null })).source("u1")).toBeNull();
    const failed = await setup({ exp: NOW }, () =>
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    );
    expect(await failed.source("u1")).toBeNull();
    expect(failed.update).not.toHaveBeenCalled();
    const down = await setup({ exp: NOW }, () => {
      throw new Error("network old-refresh");
    });
    expect(await down.source("u1")).toBeNull();
  });
});
