import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { IsolationError, requireMembership } from "./scope.js";

function prismaForMembership(found: boolean) {
  return {
    spaceMember: {
      findFirst: vi.fn(async ({ where }: { where: { userId: string; spaceId?: string } }) =>
        found
          ? {
              userId: where.userId,
              spaceId: where.spaceId ?? "space-default",
              member: { user: { email: "owner@example.test" } },
            }
          : null,
      ),
    },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({ ownerUserId: "user-1" })),
    },
  } as unknown as PrismaClient;
}

describe("requireMembership", () => {
  it("scopes the actor to an explicitly requested space", async () => {
    const prisma = prismaForMembership(true);

    await expect(requireMembership(prisma, "user-1", "space-support")).resolves.toEqual({
      userId: "user-1",
      spaceId: "space-support",
      email: "owner@example.test",
      isDeploymentOwner: true,
    });
    expect(prisma.spaceMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", spaceId: "space-support" },
      }),
    );
  });

  it("rejects a requested space the user does not belong to", async () => {
    await expect(
      requireMembership(prismaForMembership(false), "user-1", "space-foreign"),
    ).rejects.toBeInstanceOf(IsolationError);
  });

  it("puts the superadmin in the company Space instead of its own", async () => {
    const own = {
      userId: "sa",
      spaceId: "space-own",
      role: "owner",
      space: { isDefault: true },
      member: { user: { email: "superadmin@botter.invalid" } },
    };
    const prisma = {
      spaceMember: {
        findFirst: vi.fn(async ({ where }: { where: { spaceId?: string } }) =>
          where.spaceId === "space-company" ? { ...own, spaceId: "space-company" } : own,
        ),
      },
      deploymentSettings: {
        findUnique: vi.fn(async () => ({ ownerUserId: "sa", companySpaceId: "space-company" })),
      },
    } as unknown as PrismaClient;
    await expect(requireMembership(prisma, "sa")).resolves.toMatchObject({
      spaceId: "space-company",
      isDeploymentOwner: true,
    });
    // Asking for its own Space lands in the company Space as well.
    await expect(requireMembership(prisma, "sa", "space-own")).resolves.toMatchObject({
      spaceId: "space-company",
    });
  });

  it("selects the explicit default Space before older non-default memberships", async () => {
    const prisma = prismaForMembership(true);

    await requireMembership(prisma, "user-1");

    expect(prisma.spaceMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ space: { isDefault: "desc" } }, { createdAt: "asc" }, { id: "asc" }],
      }),
    );
  });
});
