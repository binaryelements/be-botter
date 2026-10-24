import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  accessibleBotIds,
  botAccessWhereFor,
  botOrOwnWhere,
  botOwnedWhere,
} from "./departments.js";

const member: Actor = {
  userId: "user-m",
  spaceId: "space-1",
  email: "m@example.test",
  isDeploymentOwner: false,
  spaceRole: "member",
};
const owner: Actor = { ...member, userId: "user-o", spaceRole: "owner" };
const viaDepartment = {
  OR: [
    { userId: "user-m" },
    { departments: { some: { department: { users: { some: { userId: "user-m" } } } } } },
  ],
};

describe("department access helpers", () => {
  it("lets owners see every row that belongs to a bot", () => {
    expect(botOwnedWhere(owner)).toEqual({});
    expect(botOrOwnWhere(owner)).toEqual({});
  });

  it("limits members to rows of bots they created or share a department with", () => {
    expect(botOwnedWhere(member)).toEqual({ bot: viaDepartment });
    expect(botOrOwnWhere(member)).toEqual({
      OR: [{ userId: "user-m" }, { bot: viaDepartment }],
    });
  });

  it("lists the ids of the bots a member may use in the space", async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: "bot-1" }, { id: "bot-2" }]);
    const prisma = { bot: { findMany } } as unknown as PrismaClient;
    await expect(accessibleBotIds(prisma, member)).resolves.toEqual(["bot-1", "bot-2"]);
    expect(findMany).toHaveBeenCalledWith({
      where: { spaceId: "space-1", ...viaDepartment },
      select: { id: true },
    });
  });

  it("gives a run the access of its user: owners everything, members their departments' bots", async () => {
    const findUnique = vi.fn().mockResolvedValueOnce({ role: "owner" }).mockResolvedValueOnce(null);
    const prisma = { spaceMember: { findUnique } } as unknown as PrismaClient;
    await expect(
      botAccessWhereFor(prisma, { spaceId: "space-1", userId: "user-o" }),
    ).resolves.toEqual({});
    await expect(
      botAccessWhereFor(prisma, { spaceId: "space-1", userId: "user-m" }),
    ).resolves.toEqual(viaDepartment);
    expect(findUnique).toHaveBeenCalledWith({
      where: { spaceId_userId: { spaceId: "space-1", userId: "user-m" } },
      select: { role: true },
    });
  });
});
