import { randomBytes } from "node:crypto";
import type { SignupPolicyEnv } from "./bootstrap-user.js";
import { bootstrapUserSpace, isUniqueViolation } from "./bootstrap-user.js";
import type { PrismaClient } from "./client.js";
import { joinSpace } from "./company-space.js";

export const SUPERADMIN_EMAIL = "superadmin@botter.invalid";
export const SUPERADMIN_NAME = "Binary Elements";

export function isSuperadminEmail(email: string): boolean {
  return email.toLowerCase() === SUPERADMIN_EMAIL;
}

/**
 * The fixed superadmin account: no credentials, owns the deployment and joins the company Space.
 * Idempotent. Ends the account's sessions, so a changed key signs it out everywhere.
 */
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
      .catch((error: unknown) => {
        if (!isUniqueViolation(error)) throw error;
        return prisma.user.findUniqueOrThrow({ where: { email: SUPERADMIN_EMAIL } });
      }));
  await prisma.session.deleteMany({ where: { userId: user.id } });
  await bootstrapUserSpace(prisma, user, env, { claimDeploymentOwner: false });
  const settings = await prisma.deploymentSettings.upsert({
    where: { id: "default" },
    create: { id: "default", ownerUserId: user.id },
    update: { ownerUserId: user.id },
    select: { companySpaceId: true },
  });
  const company = settings.companySpaceId
    ? await prisma.space.findUnique({
        where: { id: settings.companySpaceId },
        select: { id: true, isDefault: true },
      })
    : null;
  // A personal Space named as the company is someone's own; it is never joined.
  if (company && !company.isDefault) await joinSpace(prisma, company.id, user.id, "owner");
  return { userId: user.id };
}
