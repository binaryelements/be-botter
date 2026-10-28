import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { isSuperadminEmail } from "./superadmin.js";

export class IsolationError extends Error {
  constructor(message = "Resource not found") {
    super(message);
    this.name = "IsolationError";
  }
}

/** Unique (spaceId, userId, name) collision when renaming a bot section. */
export class BotSectionNameConflictError extends Error {
  constructor(message = "Section name already used") {
    super(message);
    this.name = "BotSectionNameConflictError";
  }
}

export async function requireMembership(
  prisma: PrismaClient,
  userId: string,
  requestedSpaceId?: string | null,
): Promise<Actor> {
  const include = { member: { include: { user: true } }, space: { select: { isDefault: true } } };
  const [membership, settings] = await Promise.all([
    prisma.spaceMember.findFirst({
      where: {
        userId,
        ...(requestedSpaceId ? { spaceId: requestedSpaceId } : {}),
      },
      orderBy: [{ space: { isDefault: "desc" } }, { createdAt: "asc" }, { id: "asc" }],
      include,
    }),
    prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
  ]);
  if (!membership) {
    throw new IsolationError("No personal space");
  }
  // The superadmin works in the company Space; its own Space is only where its account lives.
  const company = settings?.companySpaceId;
  const inCompany =
    company &&
    company !== membership.spaceId &&
    membership.space?.isDefault &&
    isSuperadminEmail(membership.member.user.email)
      ? await prisma.spaceMember.findFirst({ where: { userId, spaceId: company }, include })
      : null;
  const active = inCompany ?? membership;
  return {
    userId: membership.userId,
    spaceId: active.spaceId,
    email: membership.member.user.email,
    isDeploymentOwner: settings?.ownerUserId === membership.userId,
    spaceRole: active.role,
  };
}

export function scoped<T extends { spaceId: string; userId?: string }>(
  actor: Actor,
  record: T | null,
): T {
  if (!record || record.spaceId !== actor.spaceId) {
    throw new IsolationError();
  }
  if (record.userId && record.userId !== actor.userId) {
    throw new IsolationError();
  }
  return record;
}
