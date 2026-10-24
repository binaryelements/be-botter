import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";

/** Unique (spaceId, name) collision when creating or renaming a department. */
export class DepartmentNameConflictError extends Error {
  constructor(message = "Department name already used") {
    super(message);
    this.name = "DepartmentNameConflictError";
  }
}

/** The actor is not allowed to manage this: not a space owner, or not a head of the department. */
export class DepartmentPermissionError extends Error {
  constructor(message = "Only a space owner can do this") {
    super(message);
    this.name = "DepartmentPermissionError";
  }
}

/** An email in setDepartmentUsers that no account has. */
export class UnknownAccountError extends Error {
  constructor(email: string) {
    super(`No account with the email ${email}`);
    this.name = "UnknownAccountError";
  }
}

export type DepartmentRole = "member" | "head";

export interface DepartmentUserView {
  userId: string;
  email: string;
  name: string;
  role: DepartmentRole;
}

export interface DepartmentView {
  id: string;
  name: string;
  users: DepartmentUserView[];
  botIds: string[];
  /** The actor may change who is in this department: space owners and its heads. */
  canManageUsers: boolean;
}

/** Space owners and the deployment owner see and manage everything in the space. */
export function isSpaceOwner(actor: Actor): boolean {
  return actor.isDeploymentOwner || actor.spaceRole === "owner";
}

/**
 * Bots a person who is not a space owner may use: the ones they created and the
 * ones in a department they belong to.
 */
export function departmentBotAccessWhere(userId: string): Prisma.BotWhereInput {
  return {
    OR: [{ userId }, { departments: { some: { department: { users: { some: { userId } } } } } }],
  };
}

/** Bots the actor may use in the active space; spread into a bot `where`. */
export function botAccessWhere(actor: Actor): Prisma.BotWhereInput {
  return isSpaceOwner(actor) ? {} : departmentBotAccessWhere(actor.userId);
}

/** Rows with a required `bot` relation (routines, runs, skills): visible when the bot is. */
export function botOwnedWhere(actor: Actor): { bot?: Prisma.BotWhereInput } {
  return isSpaceOwner(actor) ? {} : { bot: departmentBotAccessWhere(actor.userId) };
}

/** Rows with an optional `bot` (threads, artifacts, memory): the actor's own, or their bot's. */
export function botOrOwnWhere(actor: Actor): {
  OR?: Array<{ userId: string } | { bot: Prisma.BotWhereInput }>;
} {
  return isSpaceOwner(actor)
    ? {}
    : { OR: [{ userId: actor.userId }, { bot: departmentBotAccessWhere(actor.userId) }] };
}

/**
 * Bot access for a run or job that knows only the acting user's id: space owners
 * see every bot, everyone else their own and their departments'.
 * shortcut: the deployment owner outside a space they own counts as a member, upgrade when runs carry the actor's role
 */
export async function botAccessWhereFor(
  prisma: Pick<PrismaClient, "spaceMember"> | Prisma.TransactionClient,
  scope: { spaceId: string; userId: string },
): Promise<Prisma.BotWhereInput> {
  const member = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: scope.spaceId, userId: scope.userId } },
    select: { role: true },
  });
  return member?.role === "owner" ? {} : departmentBotAccessWhere(scope.userId);
}

/** Ids of the bots the actor may use in the active space, for raw SQL filters. */
export async function accessibleBotIds(
  prisma: Pick<PrismaClient, "bot"> | Prisma.TransactionClient,
  actor: Actor,
): Promise<string[]> {
  const rows = await prisma.bot.findMany({
    where: { spaceId: actor.spaceId, ...botAccessWhere(actor) },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

const departmentInclude = {
  users: {
    include: { user: { select: { email: true, name: true } } },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
  },
  bots: { select: { botId: true }, orderBy: { createdAt: "asc" } },
} satisfies Prisma.DepartmentInclude;

type DepartmentRow = Prisma.DepartmentGetPayload<{ include: typeof departmentInclude }>;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

export function createDepartmentRepos(prisma: PrismaClient) {
  function toView(actor: Actor, row: DepartmentRow): DepartmentView {
    const users = row.users.map((link) => ({
      userId: link.userId,
      email: link.user.email,
      name: link.user.name,
      role: link.role === "head" ? ("head" as const) : ("member" as const),
    }));
    return {
      id: row.id,
      name: row.name,
      users,
      botIds: row.bots.map((link) => link.botId),
      canManageUsers:
        isSpaceOwner(actor) ||
        users.some((user) => user.userId === actor.userId && user.role === "head"),
    };
  }

  async function requireDepartment(actor: Actor, departmentId: string): Promise<DepartmentRow> {
    const row = await prisma.department.findFirst({
      where: { id: departmentId, spaceId: actor.spaceId },
      include: departmentInclude,
    });
    if (!row) throw new IsolationError();
    return row;
  }

  function requireOwner(actor: Actor) {
    if (!isSpaceOwner(actor)) throw new DepartmentPermissionError();
  }

  return {
    async listDepartments(actor: Actor): Promise<DepartmentView[]> {
      const rows = await prisma.department.findMany({
        where: { spaceId: actor.spaceId },
        include: departmentInclude,
        orderBy: [{ name: "asc" }, { createdAt: "asc" }],
      });
      return rows.map((row) => toView(actor, row));
    },

    async createDepartment(actor: Actor, input: { name: string }): Promise<DepartmentView> {
      requireOwner(actor);
      try {
        const row = await prisma.department.create({
          data: { spaceId: actor.spaceId, name: input.name },
          include: departmentInclude,
        });
        return toView(actor, row);
      } catch (error) {
        if (isUniqueViolation(error)) throw new DepartmentNameConflictError();
        throw error;
      }
    },

    async renameDepartment(
      actor: Actor,
      input: { departmentId: string; name: string },
    ): Promise<DepartmentView> {
      requireOwner(actor);
      await requireDepartment(actor, input.departmentId);
      try {
        const row = await prisma.department.update({
          where: { id: input.departmentId },
          data: { name: input.name },
          include: departmentInclude,
        });
        return toView(actor, row);
      } catch (error) {
        if (isUniqueViolation(error)) throw new DepartmentNameConflictError();
        throw error;
      }
    },

    async deleteDepartment(actor: Actor, input: { departmentId: string }): Promise<void> {
      requireOwner(actor);
      await requireDepartment(actor, input.departmentId);
      await prisma.department.delete({ where: { id: input.departmentId } });
    },

    /**
     * Replace who is in a department. Each person is named by the email of an
     * existing account and joins the space as a member when they are not one yet;
     * leaving a department never removes space membership. Space owners and the
     * department's heads may do this.
     */
    async setDepartmentUsers(
      actor: Actor,
      input: { departmentId: string; users: Array<{ email: string; role: DepartmentRole }> },
    ): Promise<DepartmentView> {
      const department = await requireDepartment(actor, input.departmentId);
      const isHead = department.users.some(
        (link) => link.userId === actor.userId && link.role === "head",
      );
      if (!isSpaceOwner(actor) && !isHead) {
        throw new DepartmentPermissionError("Only a space owner or a department head can do this");
      }
      const roleByEmail = new Map<string, DepartmentRole>();
      for (const user of input.users) roleByEmail.set(user.email.trim().toLowerCase(), user.role);
      const emails = [...roleByEmail.keys()];
      const accounts = emails.length
        ? await prisma.user.findMany({
            where: { email: { in: emails, mode: "insensitive" } },
            select: { id: true, email: true },
          })
        : [];
      const accountByEmail = new Map(accounts.map((user) => [user.email.toLowerCase(), user]));
      const members = emails.map((email) => {
        const account = accountByEmail.get(email);
        if (!account) throw new UnknownAccountError(email);
        return { userId: account.id, role: roleByEmail.get(email) ?? "member" };
      });
      const space = await prisma.space.findUniqueOrThrow({
        where: { id: actor.spaceId },
        select: { organizationId: true },
      });
      const now = new Date();
      await prisma.$transaction(async (tx) => {
        for (const { userId } of members) {
          await tx.member.upsert({
            where: { organizationId_userId: { organizationId: space.organizationId, userId } },
            update: {},
            create: {
              id: randomUUID(),
              organizationId: space.organizationId,
              userId,
              role: "member",
              createdAt: now,
            },
          });
          await tx.spaceMember.upsert({
            where: { spaceId_userId: { spaceId: actor.spaceId, userId } },
            update: {},
            create: {
              id: randomUUID(),
              spaceId: actor.spaceId,
              organizationId: space.organizationId,
              userId,
              role: "member",
              createdAt: now,
            },
          });
        }
        await tx.departmentUser.deleteMany({
          where: {
            departmentId: department.id,
            userId: { notIn: members.map((member) => member.userId) },
          },
        });
        for (const { userId, role } of members) {
          await tx.departmentUser.upsert({
            where: { departmentId_userId: { departmentId: department.id, userId } },
            update: { role },
            create: { departmentId: department.id, userId, role },
          });
        }
      });
      return toView(actor, await requireDepartment(actor, department.id));
    },

    /** Replace the departments a bot belongs to. Space owners only. */
    async setBotDepartments(
      actor: Actor,
      input: { botId: string; departmentIds: string[] },
    ): Promise<string[]> {
      requireOwner(actor);
      const bot = await prisma.bot.findFirst({
        where: { id: input.botId, spaceId: actor.spaceId },
        select: { id: true },
      });
      if (!bot) throw new IsolationError();
      const departmentIds = [...new Set(input.departmentIds)];
      const found = departmentIds.length
        ? await prisma.department.count({
            where: { id: { in: departmentIds }, spaceId: actor.spaceId },
          })
        : 0;
      if (found !== departmentIds.length) throw new IsolationError();
      await prisma.$transaction(async (tx) => {
        await tx.departmentBot.deleteMany({
          where: { botId: bot.id, departmentId: { notIn: departmentIds } },
        });
        for (const departmentId of departmentIds) {
          await tx.departmentBot.upsert({
            where: { departmentId_botId: { departmentId, botId: bot.id } },
            update: {},
            create: { departmentId, botId: bot.id },
          });
        }
      });
      const links = await prisma.departmentBot.findMany({
        where: { botId: bot.id },
        select: { departmentId: true },
        orderBy: { createdAt: "asc" },
      });
      return links.map((link) => link.departmentId);
    },

    /** Department ids per bot, for bots in the active space. */
    async botDepartmentIds(actor: Actor, botIds: string[]): Promise<Map<string, string[]>> {
      if (botIds.length === 0) return new Map();
      const links = await prisma.departmentBot.findMany({
        where: { botId: { in: botIds }, department: { spaceId: actor.spaceId } },
        select: { botId: true, departmentId: true },
        orderBy: { createdAt: "asc" },
      });
      const byBot = new Map<string, string[]>();
      for (const link of links) {
        const list = byBot.get(link.botId) ?? [];
        list.push(link.departmentId);
        byBot.set(link.botId, list);
      }
      return byBot;
    },
  };
}

/**
 * Whether the actor may open a department's channel with a bot: the department holds the
 * bot, and the actor is a space owner or one of the department's people.
 */
export async function canOpenChannel(
  prisma: PrismaClient | Prisma.TransactionClient,
  actor: Actor,
  botId: string,
  departmentId: string,
): Promise<boolean> {
  const department = await prisma.department.findFirst({
    where: {
      id: departmentId,
      spaceId: actor.spaceId,
      bots: { some: { botId } },
      ...(isSpaceOwner(actor) ? {} : { users: { some: { userId: actor.userId } } }),
    },
    select: { id: true },
  });
  return department !== null;
}

/**
 * Whether the actor may read another person's private thread with a bot: space owners for
 * anyone in the space, department heads for the people of a department that holds the bot.
 */
export async function supervises(
  prisma: PrismaClient | Prisma.TransactionClient,
  actor: Actor,
  botId: string,
  userId: string,
): Promise<boolean> {
  if (userId === actor.userId) return false;
  if (isSpaceOwner(actor)) {
    const member = await prisma.spaceMember.findFirst({
      where: { spaceId: actor.spaceId, userId },
      select: { id: true },
    });
    return member !== null;
  }
  const department = await prisma.department.findFirst({
    where: {
      spaceId: actor.spaceId,
      bots: { some: { botId } },
      AND: [
        { users: { some: { userId: actor.userId, role: "head" } } },
        { users: { some: { userId } } },
      ],
    },
    select: { id: true },
  });
  return department !== null;
}
