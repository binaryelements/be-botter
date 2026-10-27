import { randomUUID } from "node:crypto";
import { joinSpace } from "./company-space.js";
import type { PrismaClient } from "./generated/prisma/client.js";

export class CompanySetupError extends Error {
  constructor(readonly code: "company-exists") {
    super(code);
    this.name = "CompanySetupError";
  }
}

export interface CompanySetup {
  companySpaceId: string | null;
  companyName: string | null;
  ownerEmail: string | null;
  readyAt: Date | null;
  signInMode: "invited" | "organisation";
  tenantId: string | null;
}

/**
 * The company gets its own organization and Space, separate from the superadmin's personal one.
 * Refuses when a company Space is already set, unless that is just the superadmin's own default Space.
 */
export async function createCompanySpace(
  db: PrismaClient,
  superadmin: { userId: string },
  name: string,
): Promise<{ spaceId: string }> {
  return db.$transaction(async (tx) => {
    const settings = await tx.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { companySpaceId: true },
    });
    if (settings?.companySpaceId) {
      const current = await tx.spaceMember.findFirst({
        where: {
          spaceId: settings.companySpaceId,
          userId: superadmin.userId,
          role: "owner",
          space: { isDefault: true },
        },
        select: { id: true },
      });
      if (!current) throw new CompanySetupError("company-exists");
    }
    const id = randomUUID();
    const now = new Date();
    await tx.organization.create({ data: { id, name, slug: `company-${id}`, createdAt: now } });
    await tx.member.create({
      data: {
        id: randomUUID(),
        organizationId: id,
        userId: superadmin.userId,
        role: "owner",
        createdAt: now,
      },
    });
    await tx.space.create({
      data: {
        id,
        organizationId: id,
        name,
        isDefault: false,
        createdByUserId: superadmin.userId,
        createdAt: now,
      },
    });
    await tx.spaceMember.create({
      data: {
        id: randomUUID(),
        spaceId: id,
        organizationId: id,
        userId: superadmin.userId,
        role: "owner",
        createdAt: now,
      },
    });
    await tx.notificationPreference.create({ data: { spaceId: id, userId: superadmin.userId } });
    await tx.memoryDocument.create({
      data: {
        spaceId: id,
        userId: superadmin.userId,
        scope: "user",
        path: "MEMORY.md",
        content: "# Space memory\n\nPreferences and context kept within this space live here.\n",
      },
    });
    await tx.deploymentSettings.upsert({
      where: { id: "default" },
      update: { companySpaceId: id },
      create: { id: "default", companySpaceId: id },
    });
    return { spaceId: id };
  });
}

export async function readCompanySetup(db: PrismaClient): Promise<CompanySetup> {
  const settings = await db.deploymentSettings.findUnique({ where: { id: "default" } });
  const space = settings?.companySpaceId
    ? await db.space.findUnique({
        where: { id: settings.companySpaceId },
        select: { name: true },
      })
    : null;
  return {
    companySpaceId: settings?.companySpaceId ?? null,
    companyName: space?.name ?? null,
    ownerEmail: settings?.companyOwnerEmail ?? null,
    readyAt: settings?.companyReadyAt ?? null,
    signInMode: settings?.signInMode === "organisation" ? "organisation" : "invited",
    tenantId: settings?.companyTenantId ?? null,
  };
}

export async function updateCompanySetup(
  db: PrismaClient,
  patch: Partial<Pick<CompanySetup, "ownerEmail" | "readyAt" | "signInMode" | "tenantId">>,
): Promise<void> {
  const data = {
    ...(patch.ownerEmail !== undefined && {
      companyOwnerEmail: patch.ownerEmail?.toLowerCase() ?? null,
    }),
    ...(patch.readyAt !== undefined && { companyReadyAt: patch.readyAt }),
    ...(patch.signInMode !== undefined && { signInMode: patch.signInMode }),
    ...(patch.tenantId !== undefined && { companyTenantId: patch.tenantId }),
  };
  await db.deploymentSettings.upsert({
    where: { id: "default" },
    update: data,
    create: { id: "default", ...data },
  });
}

/**
 * Accepts the pending invitation for this email, once: the person joins the Space as a member and
 * the invited departments that still exist in it. Returns whether there was one to accept.
 */
export async function acceptInvitation(
  db: PrismaClient,
  { spaceId, email, userId }: { spaceId: string; email: string; userId: string },
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const invitation = await tx.spaceInvitation.findUnique({
      where: { spaceId_email: { spaceId, email: email.toLowerCase() } },
    });
    if (!invitation || invitation.acceptedAt) return false;
    const claimed = await tx.spaceInvitation.updateMany({
      where: { id: invitation.id, acceptedAt: null },
      data: { acceptedAt: new Date(), acceptedUserId: userId },
    });
    if (claimed.count === 0) return false;
    await joinSpace(tx, spaceId, userId);
    const links = invitation.departments as { departmentId: string; role: string }[];
    const departments = await tx.department.findMany({
      where: { spaceId, id: { in: links.map((link) => link.departmentId) } },
      select: { id: true },
    });
    for (const { id } of departments) {
      const role =
        links.find((link) => link.departmentId === id)?.role === "head" ? "head" : "member";
      await tx.departmentUser.upsert({
        where: { departmentId_userId: { departmentId: id, userId } },
        update: { role },
        create: { departmentId: id, userId, role },
      });
    }
    return true;
  });
}
