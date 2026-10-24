import type { Actor } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import {
  createDepartmentRepos,
  DepartmentNameConflictError,
  DepartmentPermissionError,
} from "./departments.js";
import { createRepos } from "./repos.js";
import { asSystem, runAsTenant } from "./row-security.js";
import { IsolationError } from "./scope.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("departments (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `dept-org-${suffix}`;
  const spaceId = `dept-space-${suffix}`;
  const ownerId = `dept-owner-${suffix}`;
  const itStaffId = `dept-it-${suffix}`;
  const accountsStaffId = `dept-accounts-${suffix}`;
  const email = (id: string) => `${id}@rakazo.test`;
  const actorFor = (userId: string, spaceRole: "owner" | "member"): Actor => ({
    userId,
    spaceId,
    email: email(userId),
    isDeploymentOwner: false,
    spaceRole,
  });
  const owner = actorFor(ownerId, "owner");
  const itStaff = actorFor(itStaffId, "member");
  const accountsStaff = actorFor(accountsStaffId, "member");

  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let itBotId: string;
  let chiefBotId: string;
  let itDepartmentId: string;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    for (const id of [ownerId, itStaffId, accountsStaffId]) {
      await system.user.create({
        data: { id, name: id, email: email(id), emailVerified: false },
      });
    }
    await system.organization.create({
      data: { id: organizationId, name: "Dept Co", slug: organizationId, createdAt: new Date() },
    });
    await system.space.create({
      data: { id: spaceId, organizationId, name: "Dept Co", isDefault: true },
    });
    await system.member.create({
      data: {
        id: `dept-member-${suffix}`,
        organizationId,
        userId: ownerId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await system.spaceMember.upsert({
      where: { spaceId_userId: { spaceId, userId: ownerId } },
      update: { role: "owner" },
      create: {
        id: `dept-space-member-${suffix}`,
        spaceId,
        organizationId,
        userId: ownerId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    const createBot = async (name: string, color: string) => {
      const bot = await system.bot.create({ data: { spaceId, userId: ownerId, name, color } });
      await system.thread.create({ data: { spaceId, userId: ownerId, botId: bot.id } });
      return bot.id;
    };
    itBotId = await createBot("IT Support", "#3B82F6");
    chiefBotId = await createBot("Chief", "#F5A03C");
  });

  afterAll(async () => {
    if (!prisma) return;
    await system.organization.deleteMany({ where: { id: organizationId } });
    await system.user.deleteMany({ where: { id: { in: [ownerId, itStaffId, accountsStaffId] } } });
    await close();
  });

  it("creates a department in the owner's space with a unique name", async () => {
    const departments = createDepartmentRepos(prisma);
    const created = await runAsTenant(owner, () =>
      departments.createDepartment(owner, { name: "IT" }),
    );
    itDepartmentId = created.id;
    expect(created).toMatchObject({ name: "IT", users: [], botIds: [] });
    await expect(
      runAsTenant(owner, () => departments.createDepartment(owner, { name: "IT" })),
    ).rejects.toBeInstanceOf(DepartmentNameConflictError);
  });

  it("adds people by email and makes them members of the space", async () => {
    const departments = createDepartmentRepos(prisma);
    const updated = await runAsTenant(owner, () =>
      departments.setDepartmentUsers(owner, {
        departmentId: itDepartmentId,
        users: [{ email: email(itStaffId), role: "head" }],
      }),
    );
    expect(updated.users).toEqual([
      { userId: itStaffId, email: email(itStaffId), name: itStaffId, role: "head" },
    ]);
    const membership = await system.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId, userId: itStaffId } },
    });
    expect(membership?.role).toBe("member");
    const member = await system.member.findUnique({
      where: { organizationId_userId: { organizationId, userId: itStaffId } },
    });
    expect(member?.role).toBe("member");
  });

  it("rejects an email with no account", async () => {
    const departments = createDepartmentRepos(prisma);
    await expect(
      runAsTenant(owner, () =>
        departments.setDepartmentUsers(owner, {
          departmentId: itDepartmentId,
          users: [{ email: "nobody@rakazo.test", role: "member" }],
        }),
      ),
    ).rejects.toThrow(/no account/i);
  });

  it("lets only the department's heads and space owners change its people", async () => {
    const departments = createDepartmentRepos(prisma);
    await expect(
      runAsTenant(accountsStaff, () =>
        departments.setDepartmentUsers(accountsStaff, {
          departmentId: itDepartmentId,
          users: [{ email: email(accountsStaffId), role: "member" }],
        }),
      ),
    ).rejects.toBeInstanceOf(DepartmentPermissionError);
    const byHead = await runAsTenant(itStaff, () =>
      departments.setDepartmentUsers(itStaff, {
        departmentId: itDepartmentId,
        users: [
          { email: email(itStaffId), role: "head" },
          { email: email(accountsStaffId), role: "member" },
        ],
      }),
    );
    expect(byHead.users.map((user) => user.userId).sort()).toEqual(
      [itStaffId, accountsStaffId].sort(),
    );
    // Back to IT only; the removed person keeps their space membership.
    await runAsTenant(itStaff, () =>
      departments.setDepartmentUsers(itStaff, {
        departmentId: itDepartmentId,
        users: [{ email: email(itStaffId), role: "head" }],
      }),
    );
    const membership = await system.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId, userId: accountsStaffId } },
    });
    expect(membership).not.toBeNull();
  });

  it("assigns bots to departments, owner only", async () => {
    const departments = createDepartmentRepos(prisma);
    await expect(
      runAsTenant(itStaff, () =>
        departments.setBotDepartments(itStaff, {
          botId: itBotId,
          departmentIds: [itDepartmentId],
        }),
      ),
    ).rejects.toBeInstanceOf(DepartmentPermissionError);
    const assigned = await runAsTenant(owner, () =>
      departments.setBotDepartments(owner, { botId: itBotId, departmentIds: [itDepartmentId] }),
    );
    expect(assigned).toEqual([itDepartmentId]);
    const listed = await runAsTenant(owner, () => departments.listDepartments(owner));
    expect(listed).toEqual([
      expect.objectContaining({ id: itDepartmentId, name: "IT", botIds: [itBotId] }),
    ]);
  });

  it("shows a department member the department's bots and nothing else", async () => {
    const repos = createRepos(prisma);
    const seenByIt = await runAsTenant(itStaff, () => repos.listBots(itStaff));
    expect(seenByIt.map((bot) => bot.id)).toEqual([itBotId]);
    const seenByAccounts = await runAsTenant(accountsStaff, () => repos.listBots(accountsStaff));
    expect(seenByAccounts).toEqual([]);
    const seenByOwner = await runAsTenant(owner, () => repos.listBots(owner));
    expect(seenByOwner.map((bot) => bot.id).sort()).toEqual([chiefBotId, itBotId].sort());
  });

  it("resolves a department bot for its members and hides it from others", async () => {
    const repos = createRepos(prisma);
    const bot = await runAsTenant(itStaff, () => repos.getBot(itStaff, itBotId));
    expect(bot.id).toBe(itBotId);
    await expect(
      runAsTenant(itStaff, () => repos.getBot(itStaff, chiefBotId)),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      runAsTenant(accountsStaff, () => repos.getBot(accountsStaff, itBotId)),
    ).rejects.toBeInstanceOf(IsolationError);
  });

  it("removes a department and the access that came with it", async () => {
    const departments = createDepartmentRepos(prisma);
    const repos = createRepos(prisma);
    await expect(
      runAsTenant(itStaff, () =>
        departments.deleteDepartment(itStaff, { departmentId: itDepartmentId }),
      ),
    ).rejects.toBeInstanceOf(DepartmentPermissionError);
    await runAsTenant(owner, () =>
      departments.deleteDepartment(owner, { departmentId: itDepartmentId }),
    );
    expect(await runAsTenant(owner, () => departments.listDepartments(owner))).toEqual([]);
    expect(await runAsTenant(itStaff, () => repos.listBots(itStaff))).toEqual([]);
  });
});
