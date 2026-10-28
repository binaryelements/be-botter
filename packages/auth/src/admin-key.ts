import { timingSafeEqual } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";

function sameKey(supplied: string, expected: string) {
  // Compare lengths first so an oversized key is never copied.
  if (supplied.length !== expected.length) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Signs the fixed superadmin in with the site's admin key. Only registered when a key is set. */
export function adminKeySignIn({
  key,
  superadminEmail,
}: {
  key: string;
  superadminEmail: string;
}): BetterAuthPlugin {
  return {
    id: "admin-key",
    endpoints: {
      signInAdminKey: createAuthEndpoint("/sign-in/admin-key", { method: "POST" }, async (ctx) => {
        const supplied = (ctx.body as { key?: unknown } | undefined)?.key;
        const user =
          typeof supplied === "string" && sameKey(supplied, key)
            ? await ctx.context.internalAdapter.findUserByEmail(superadminEmail)
            : null;
        if (!user) {
          throw new APIError("FORBIDDEN", { code: "WRONG_ADMIN_KEY", message: "Wrong admin key" });
        }
        const session = await ctx.context.internalAdapter.createSession(user.user.id);
        await setSessionCookie(ctx, { session, user: user.user });
        return ctx.json({ ok: true });
      }),
    },
  };
}
