import type { SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { symmetricDecrypt } from "better-auth/crypto";
import type { OidcConfig } from "./oidc.js";
import type { TokenKey } from "./token-storage.js";

export type PersonToken = { accessToken: string; expiresAt: number };
/** What is kept of a person's SSO sign-in: the access token, its expiry and the refresh token. */
export type SsoToken = PersonToken & { refreshToken?: string };

type SsoTokenStore = {
  prisma: Pick<PrismaClient, "secret">;
  secrets: Pick<SecretStore, "put" | "load">;
};

/** Account-level secret (no Space): the secrets scope check lists it with model and voice. */
const KIND = "sso-token";
/** A token this close to expiry is not handed out; the connector replaces sessions this early. */
const USABLE_SKEW = 60_000;
/** The API refreshes a token that expires within this, on the person's next request. */
const REFRESH_WITHIN = 45 * 60_000;
/** At most one refresh check per person this often. */
const RETRY_AFTER = 5 * 60_000;

async function readSsoToken(
  { prisma, secrets }: SsoTokenStore,
  userId: string,
): Promise<SsoToken | null> {
  const row = await prisma.secret.findFirst({
    where: { userId, spaceId: null, kind: KIND },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return null;
  return JSON.parse(await secrets.load(row.ciphertext, { recordId: row.id })) as SsoToken;
}

/** Store a person's SSO token in the app's secret store, replacing the previous one. */
export async function saveSsoToken(
  { prisma, secrets }: SsoTokenStore,
  userId: string,
  token: SsoToken,
): Promise<void> {
  const stored = await secrets.put(JSON.stringify(token), {
    operationId: KIND,
    traceId: KIND,
    spaceId: "",
    userId,
    signal: new AbortController().signal,
  });
  await prisma.secret.create({
    data: { id: stored.id, userId, spaceId: null, kind: KIND, ciphertext: stored.ciphertext },
  });
  await prisma.secret.deleteMany({
    where: { userId, spaceId: null, kind: KIND, id: { not: stored.id } },
  });
}

/** The SSO token Better Auth just stored for an OIDC sign-in, decrypted with its key. */
export async function ssoTokenFromAccount(
  key: TokenKey,
  account: {
    accessToken?: string | null;
    refreshToken?: string | null;
    accessTokenExpiresAt?: Date | null;
  },
): Promise<SsoToken | null> {
  if (!account.accessToken || !account.accessTokenExpiresAt) return null;
  return {
    accessToken: await symmetricDecrypt({ key, data: account.accessToken }),
    expiresAt: account.accessTokenExpiresAt.getTime(),
    ...(account.refreshToken && {
      refreshToken: await symmetricDecrypt({ key, data: account.refreshToken }),
    }),
  };
}

/**
 * Reads a person's current SSO access token. Never refreshes: the API does that. Missing,
 * expiring or unreadable is null, and no token value ever reaches an error or a log.
 */
export function createPersonTokenSource(
  deps: SsoTokenStore & { now?: () => number },
): (userId: string) => Promise<PersonToken | null> {
  const now = deps.now ?? Date.now;
  return async (userId) => {
    try {
      const token = await readSsoToken(deps, userId);
      if (!token || token.expiresAt - now() <= USABLE_SKEW) return null;
      return { accessToken: token.accessToken, expiresAt: token.expiresAt };
    } catch {
      return null;
    }
  };
}

/**
 * Refreshes a person's stored SSO token against the identity provider when it expires within
 * 45 minutes. Checked at most once per person every 5 minutes; never throws.
 */
export function createSsoTokenRefresher(
  deps: SsoTokenStore & { oidc: OidcConfig; fetch?: typeof fetch; now?: () => number },
): (userId: string) => Promise<void> {
  const { oidc } = deps;
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const scope = [...new Set(["openid", "email", "profile", ...oidc.scopes])].join(" ");
  const checked = new Map<string, number>();
  let endpoint: Promise<string> | undefined;
  const tokenEndpoint = () =>
    (endpoint ??= doFetch(`${oidc.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("discovery"))))
      .then((d) => {
        const { token_endpoint } = d as { token_endpoint?: unknown };
        if (typeof token_endpoint !== "string") throw new Error("discovery");
        return token_endpoint;
      })
      // A failed discovery is retried on the next refresh.
      .catch((e) => {
        endpoint = undefined;
        throw e;
      }));

  return async (userId) => {
    const at = now();
    if (at - (checked.get(userId) ?? Number.NEGATIVE_INFINITY) < RETRY_AFTER) return;
    checked.set(userId, at);
    try {
      const token = await readSsoToken(deps, userId);
      if (!token?.refreshToken || token.expiresAt - at > REFRESH_WITHIN) return;
      const response = await doFetch(await tokenEndpoint(), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: token.refreshToken,
          client_id: oidc.clientId,
          client_secret: oidc.clientSecret,
          scope,
        }),
      });
      if (!response.ok) return;
      const body = (await response.json()) as {
        access_token?: unknown;
        refresh_token?: unknown;
        expires_in?: unknown;
      };
      if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") return;
      await saveSsoToken(deps, userId, {
        accessToken: body.access_token,
        expiresAt: now() + body.expires_in * 1000,
        refreshToken:
          typeof body.refresh_token === "string" ? body.refresh_token : token.refreshToken,
      });
    } catch {
      // The person is asked to sign in again once the token lapses.
    }
  };
}
