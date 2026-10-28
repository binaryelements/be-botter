import type { PrismaClient } from "@rakazo/db";
import { acceptInvitation, joinSpace, readCompanySetup, updateCompanySetup } from "@rakazo/db";
import type { TokenKey } from "./token-storage.js";
import { openIdToken } from "./token-storage.js";

/** Microsoft's tenant for personal accounts: anyone can be in it, so it never identifies a company. */
const CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

export type Admission =
  | "not-managed"
  | "superadmin"
  | "owner"
  | "invited"
  | "organisation"
  | "denied";

/**
 * Who may join a handed-over company on their first SSO sign-in: the superadmin always, the named
 * owner as a Space owner, invited people, and (when the switch allows it) anyone from the recorded
 * Microsoft tenant. Before handover nothing changes. Emails match only when the ID token verifies
 * them; an invitation also matches from the company's own tenant, the owner never does.
 */
export async function admitCompanyPerson(
  db: PrismaClient,
  person: {
    userId: string;
    email: string;
    emailVerified: boolean;
    tenantId: string | null;
    isDeploymentOwner: boolean;
  },
  onDepartmentHeadsChanged?: (departmentIds: string[]) => Promise<void>,
): Promise<Admission> {
  const setup = await readCompanySetup(db);
  if (!setup.readyAt) return "not-managed";
  if (person.isDeploymentOwner) return "superadmin";
  const spaceId = setup.companySpaceId;
  if (!spaceId) return "denied";
  const email = person.email.toLowerCase();
  const tenantId = person.tenantId === CONSUMER_TENANT ? null : person.tenantId;
  if (person.emailVerified && email === setup.ownerEmail) {
    await joinSpace(db, spaceId, person.userId, "owner");
    if (!setup.tenantId && tenantId) await updateCompanySetup(db, { tenantId });
    return "owner";
  }
  const fromCompanyTenant = Boolean(tenantId) && tenantId === setup.tenantId;
  if (
    (person.emailVerified || fromCompanyTenant) &&
    (await acceptInvitation(db, { spaceId, email, userId: person.userId }))
  ) {
    const heads = await db.departmentUser.findMany({
      where: { userId: person.userId, role: "head" },
      select: { departmentId: true },
    });
    // Routines follow their head; a failed sync never fails the sign-in.
    if (heads.length > 0)
      await onDepartmentHeadsChanged?.(heads.map((head) => head.departmentId)).catch(
        () => undefined,
      );
    return "invited";
  }
  if (setup.signInMode === "organisation" && fromCompanyTenant) {
    await joinSpace(db, spaceId, person.userId);
    return "organisation";
  }
  return "denied";
}

/** On a site with an admin key, nobody but the deployment owner gets in until the company is ready. */
export async function refusesNewcomerBeforeReady(
  prisma: PrismaClient,
  userId: string,
): Promise<boolean> {
  if ((await readCompanySetup(prisma)).readyAt) return false;
  const settings = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { ownerUserId: true },
  });
  return settings?.ownerUserId !== userId;
}

/** On a handed-over site only SSO admits newcomers; the superadmin may still use any sign-in. */
export async function refusesNewcomerWithoutSso(
  prisma: PrismaClient,
  userId: string,
): Promise<boolean> {
  if (!(await readCompanySetup(prisma)).readyAt) return false;
  const settings = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { ownerUserId: true },
  });
  return settings?.ownerUserId !== userId;
}

/** On a handed-over site, admission decided who is in: the superadmin and company members. */
export async function isAdmittedCompanyPerson(
  prisma: PrismaClient,
  userId: string,
): Promise<boolean> {
  const setup = await readCompanySetup(prisma);
  if (!setup.readyAt || !setup.companySpaceId) return false;
  const settings = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { ownerUserId: true },
  });
  if (settings?.ownerUserId === userId) return true;
  return Boolean(
    await prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: setup.companySpaceId, userId } },
      select: { id: true },
    }),
  );
}

const TRUE_CLAIMS: unknown[] = [true, "true", 1, "1"];

/**
 * What the person's newest SSO sign-in says about them, read from its ID token (verified at the
 * callback): the Microsoft tenant (`tid`) and whether the email is verified (`email_verified`, or
 * Microsoft's `xms_edov` domain-owner claim).
 */
export async function oidcIdentity(
  key: TokenKey,
  accounts: { providerId: string; idToken?: string | null; updatedAt: Date }[],
): Promise<{ tenantId: string | null; emailVerified: boolean }> {
  const account = accounts
    .filter((candidate) => candidate.providerId === "oidc")
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
  const idToken = await openIdToken(key, account?.idToken);
  try {
    const claims = JSON.parse(Buffer.from(idToken?.split(".")[1] ?? "", "base64url").toString());
    return {
      tenantId: typeof claims.tid === "string" && claims.tid ? claims.tid : null,
      emailVerified: claims.email_verified === true || TRUE_CLAIMS.includes(claims.xms_edov),
    };
  } catch {
    return { tenantId: null, emailVerified: false };
  }
}
