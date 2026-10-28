import { randomBytes } from "node:crypto";
import type { SignupPolicyEnv } from "./bootstrap-user.js";
import { bootstrapUserSpace } from "./bootstrap-user.js";
import type { PrismaClient } from "./client.js";

export const SUPERADMIN_EMAIL = "superadmin@botter.invalid";
export const SUPERADMIN_NAME = "Binary Elements";

export function isSuperadminEmail(email: string): boolean {
  return email.toLowerCase() === SUPERADMIN_EMAIL;
}

/** The fixed superadmin account: no credentials, owns the deployment. Idempotent. */
export async function ensureSuperadmin(
  prisma: PrismaClient,
  env: SignupPolicyEnv,
): Promise<{ userId: string }> {
  const user =
    (await prisma.user.findUnique({ where: { email: SUPERADMIN_EMAIL } })) ??
    (await prisma.user
      .create({
        data: {
          id: randomBytes(16).toString("hex"),
          email: SUPERADMIN_EMAIL,
          name: SUPERADMIN_NAME,
          emailVerified: true,
        },
      })
      // A concurrent start-up created it first.
      .catch(() => prisma.user.findUniqueOrThrow({ where: { email: SUPERADMIN_EMAIL } })));
  await bootstrapUserSpace(prisma, user, env, { claimDeploymentOwner: false });
  await prisma.deploymentSettings.upsert({
    where: { id: "default" },
    create: { id: "default", ownerUserId: user.id },
    update: { ownerUserId: user.id },
  });
  return { userId: user.id };
}
