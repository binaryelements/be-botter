import type { PrismaClient } from "@rakazo/db";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import type { OidcConfig } from "./oidc.js";
import type { TokenKey } from "./token-storage.js";

export type PersonToken = { accessToken: string; expiresAt: number };

const REFRESH_WITHIN = 5 * 60_000;

/**
 * Reads the SSO access token Better Auth stored for a user, refreshing it
 * against the identity provider when it is about to expire. Any failure is
 * null, and no token value ever reaches an error or a log.
 */
export function createPersonTokenSource(deps: {
  prisma: Pick<PrismaClient, "account">;
  key: TokenKey;
  oidc: OidcConfig;
  fetch?: typeof fetch;
  now?: () => number;
}): (userId: string) => Promise<PersonToken | null> {
  const { prisma, key, oidc } = deps;
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const scope = [...new Set(["openid", "email", "profile", ...oidc.scopes])].join(" ");
  let endpoint: Promise<string> | undefined;
  const tokenEndpoint = () =>
    (endpoint ??= doFetch(`${oidc.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("discovery"))))
      .then((d) => {
        const { token_endpoint } = d as { token_endpoint?: unknown };
        if (typeof token_endpoint !== "string") throw new Error("discovery");
        return token_endpoint;
      })
      // A failed discovery is retried on the next call.
      .catch((e) => {
        endpoint = undefined;
        throw e;
      }));

  return async (userId) => {
    try {
      const account = await prisma.account.findFirst({
        where: { userId, providerId: "oidc" },
        orderBy: { createdAt: "desc" },
        select: { id: true, accessToken: true, refreshToken: true, accessTokenExpiresAt: true },
      });
      if (!account?.accessToken || !account.accessTokenExpiresAt) return null;
      const expiresAt = account.accessTokenExpiresAt.getTime();
      if (expiresAt - now() > REFRESH_WITHIN)
        return {
          accessToken: await symmetricDecrypt({ key, data: account.accessToken }),
          expiresAt,
        };
      if (!account.refreshToken) return null;
      const response = await doFetch(await tokenEndpoint(), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: await symmetricDecrypt({ key, data: account.refreshToken }),
          client_id: oidc.clientId,
          client_secret: oidc.clientSecret,
          scope,
        }),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as {
        access_token?: unknown;
        refresh_token?: unknown;
        expires_in?: unknown;
      };
      if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") return null;
      const refreshed = {
        accessToken: body.access_token,
        expiresAt: now() + body.expires_in * 1000,
      };
      await prisma.account.update({
        where: { id: account.id },
        data: {
          accessToken: await symmetricEncrypt({ key, data: refreshed.accessToken }),
          accessTokenExpiresAt: new Date(refreshed.expiresAt),
          ...(typeof body.refresh_token === "string" && {
            refreshToken: await symmetricEncrypt({ key, data: body.refresh_token }),
          }),
        },
      });
      return refreshed;
    } catch {
      return null;
    }
  };
}
