import type { Actor } from "@rakazo/contracts";
import { ADMIN_TOOL_NAMES, BOT_INSTRUCTIONS_MAX_LENGTH, DepartmentName } from "@rakazo/contracts";
import type { PrismaClient, SecurityEventType } from "@rakazo/db";
import {
  commitBotUpdate,
  createDepartmentRepos,
  createDepartmentWithBot,
  DepartmentNameConflictError,
  DepartmentPermissionError,
  listSecurityEvents,
  recordSecurityEvent,
  runAsSystem,
  UnknownAccountError,
} from "@rakazo/db";
import { z } from "zod";

const ADMIN_TOOL_NAME_SET: ReadonlySet<string> = new Set(ADMIN_TOOL_NAMES);
export function isAdminTool(name: string): boolean {
  return ADMIN_TOOL_NAME_SET.has(name);
}

const Ref = z.string().trim().min(1).max(200);
const Persona = z.string().trim().min(1).max(BOT_INSTRUCTIONS_MAX_LENGTH);

const InfoInput = z.object({
  view: z.enum(["overview", "usage", "audit"]),
  days: z.number().int().min(1).max(365).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  before: z.string().max(64).optional(),
});

const ChangeInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create_department"), name: DepartmentName }),
  z.object({ action: z.literal("rename_department"), department: Ref, name: DepartmentName }),
  z.object({ action: z.literal("remove_department"), department: Ref }),
  z.object({
    action: z.literal("set_person"),
    department: Ref,
    email: z.string().trim().email(),
    role: z.enum(["member", "head", "none"]),
  }),
  z.object({
    action: z.literal("set_department_bot"),
    department: Ref,
    bot: Ref,
    included: z.boolean(),
  }),
  z.object({ action: z.literal("set_persona_template"), instructions: Persona }),
  z.object({ action: z.literal("set_bot_persona"), bot: Ref, instructions: Persona }),
  z.object({
    action: z.literal("set_connection_departments"),
    connection: Ref,
    departments: z.array(Ref).max(100),
  }),
  z.object({ action: z.literal("set_admin_only"), enabled: z.boolean() }),
]);
type Change = z.infer<typeof ChangeInput>;

type Result = Record<string, unknown>;
type ChangeContext = {
  botId: string;
  runId: string;
  notify?: (threadId: string, seq: number) => Promise<void>;
};

function invalid(error: z.ZodError): { error: string } {
  const issue = error.issues[0];
  return { error: `${issue?.path.join(".") || "input"}: ${issue?.message ?? "invalid"}` };
}

function sameName(a: string, b: string) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Read the company's setup, its usage, or its audit trail. */
export async function adminInfo(
  prisma: PrismaClient,
  actor: Actor,
  args: Record<string, unknown>,
): Promise<Result> {
  const parsed = InfoInput.safeParse(args);
  if (!parsed.success) return invalid(parsed.error);
  const input = parsed.data;
  if (input.view === "overview") return overview(prisma, actor);
  if (input.view === "usage") return usage(prisma, actor, input.days ?? 30);
  return audit(prisma, actor, input.limit ?? 50, input.before);
}

async function overview(prisma: PrismaClient, actor: Actor): Promise<Result> {
  const departments = createDepartmentRepos(prisma);
  const [list, template, bots, connections, settings] = await Promise.all([
    departments.listDepartments(actor),
    departments.botTemplate(actor),
    prisma.bot.findMany({
      where: { spaceId: actor.spaceId, archivedAt: null },
      select: { id: true, name: true, userId: true },
      orderBy: { name: "asc" },
    }),
    prisma.mcpServer.findMany({
      where: { spaceId: actor.spaceId, shared: true },
      select: { name: true, departments: { select: { department: { select: { name: true } } } } },
      orderBy: { name: "asc" },
    }),
    runAsSystem("admin overview of the admin-only switch", () =>
      prisma.deploymentSettings.findUnique({
        where: { id: "default" },
        select: { connectionsAdminOnly: true },
      }),
    ),
  ]);
  const botName = new Map(bots.map((bot) => [bot.id, bot.name]));
  const creators = await prisma.user.findMany({
    where: { id: { in: [...new Set(bots.map((bot) => bot.userId))] } },
    select: { id: true, email: true },
  });
  const creator = new Map(creators.map((user) => [user.id, user.email]));
  return {
    departments: list.map((department) => ({
      name: department.name,
      people: department.users.map((user) => ({
        name: user.name,
        email: user.email,
        role: user.role,
      })),
      bots: department.botIds.flatMap((id) => botName.get(id) ?? []),
    })),
    bots: bots.map((bot) => ({ name: bot.name, createdBy: creator.get(bot.userId) ?? null })),
    connections: connections.map((server) => ({
      name: server.name,
      departments: server.departments.length
        ? server.departments.map((link) => link.department.name)
        : "everyone",
    })),
    personaTemplate: template,
    onlyAdminsAddBotsAndConnections: settings?.connectionsAdminOnly ?? false,
  };
}

type Totals = { runs: number; modelCalls: number; totalTokens: number; costUsd: number };
type UsageGroup = {
  _sum: { totalTokens: number | null; costUsd: number | null };
  _count: { _all: number };
};

async function usage(prisma: PrismaClient, actor: Actor, days: number): Promise<Result> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const where = { spaceId: actor.spaceId, createdAt: { gte: since } };
  const sums = { _sum: { totalTokens: true, costUsd: true }, _count: { _all: true } } as const;
  const [byPerson, byBot, runsByPerson, runsByBot] = await Promise.all([
    prisma.usageRecord.groupBy({ by: ["userId"], where, ...sums }),
    prisma.usageRecord.groupBy({ by: ["botId"], where, ...sums }),
    prisma.run.groupBy({ by: ["userId"], where, _count: { _all: true } }),
    prisma.run.groupBy({ by: ["botId"], where, _count: { _all: true } }),
  ]);
  const botIds = byBot.flatMap((row) => row.botId ?? []);
  const [users, bots, deleted] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: byPerson.map((row) => row.userId) } },
      select: { id: true, name: true, email: true },
    }),
    prisma.bot.findMany({ where: { id: { in: botIds } }, select: { id: true, name: true } }),
    // Usage outlives its bot; a deleted bot keeps its name here.
    prisma.botDeletion.findMany({
      where: { id: { in: botIds } },
      select: { id: true, name: true },
    }),
  ]);
  const runsOfPerson = new Map(runsByPerson.map((row) => [row.userId, row._count._all]));
  const runsOfBot = new Map(runsByBot.map((row) => [row.botId, row._count._all]));
  const person = new Map(users.map((user) => [user.id, user]));
  const botName = new Map([...deleted, ...bots].map((bot) => [bot.id, bot.name]));
  const totalsOf = (row: UsageGroup, runs: number): Totals => ({
    runs,
    modelCalls: row._count._all,
    totalTokens: row._sum.totalTokens ?? 0,
    costUsd: roundCost(row._sum.costUsd ?? 0),
  });
  const byCost = (a: Totals, b: Totals) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens;
  const people = byPerson
    .map((row) => ({
      name: person.get(row.userId)?.name ?? "Unknown",
      email: person.get(row.userId)?.email ?? null,
      ...totalsOf(row, runsOfPerson.get(row.userId) ?? 0),
    }))
    .sort(byCost);
  return {
    since: since.toISOString(),
    days,
    totals: people.reduce<Totals>(
      (sum, row) => ({
        runs: sum.runs + row.runs,
        modelCalls: sum.modelCalls + row.modelCalls,
        totalTokens: sum.totalTokens + row.totalTokens,
        costUsd: roundCost(sum.costUsd + row.costUsd),
      }),
      { runs: 0, modelCalls: 0, totalTokens: 0, costUsd: 0 },
    ),
    people,
    bots: byBot
      .map((row) => ({
        name: (row.botId && botName.get(row.botId)) || "Unknown bot",
        ...totalsOf(row, (row.botId && runsOfBot.get(row.botId)) || 0),
      }))
      .sort(byCost),
  };
}

function roundCost(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

async function audit(
  prisma: PrismaClient,
  actor: Actor,
  limit: number,
  before: string | undefined,
): Promise<Result> {
  const events = await runAsSystem("admin reads its space's audit trail", () =>
    listSecurityEvents(prisma, { spaceId: actor.spaceId, cursor: before, limit }),
  );
  const users = await prisma.user.findMany({
    where: { id: { in: [...new Set(events.flatMap((event) => event.userId ?? []))] } },
    select: { id: true, email: true },
  });
  const email = new Map(users.map((user) => [user.id, user.email]));
  return {
    events: events.map((event) => {
      const { procedure, via, ...details } = event.metadata;
      return {
        at: event.createdAt,
        type: event.type,
        action: typeof procedure === "string" ? procedure : event.type,
        by: event.userId ? (email.get(event.userId) ?? event.userId) : null,
        via: typeof via === "string" ? via : null,
        details,
      };
    }),
    nextBefore: events.length === limit ? events.at(-1)?.id : undefined,
  };
}

/** Change the company's setup for an admin. The executor asks the person to approve first. */
export async function adminChange(
  prisma: PrismaClient,
  actor: Actor,
  args: Record<string, unknown>,
  context: ChangeContext,
): Promise<Result> {
  const parsed = ChangeInput.safeParse(args);
  if (!parsed.success) return invalid(parsed.error);
  const change = parsed.data;
  try {
    const result = await applyChange(prisma, actor, change, context);
    if ("error" in result) return result;
    const { audit: details, type, ...reply } = result;
    await recordSecurityEvent({
      type,
      userId: actor.userId,
      spaceId: actor.spaceId,
      metadata: {
        procedure: `admin.${change.action}`,
        via: "bot",
        botId: context.botId,
        runId: context.runId,
        ...details,
      },
    });
    return { ok: true, ...reply };
  } catch (error) {
    if (
      error instanceof DepartmentNameConflictError ||
      error instanceof DepartmentPermissionError ||
      error instanceof UnknownAccountError
    )
      return { error: error.message };
    throw error;
  }
}

type Applied =
  | { error: string }
  | (Result & { type: SecurityEventType; audit: Record<string, string | boolean> });

async function applyChange(
  prisma: PrismaClient,
  actor: Actor,
  change: Change,
  context: ChangeContext,
): Promise<Applied> {
  const departments = createDepartmentRepos(prisma);
  const findDepartment = async (ref: string) => {
    const all = await departments.listDepartments(actor);
    return all.find((department) => department.id === ref || sameName(department.name, ref));
  };
  const findBot = async (ref: string) => {
    const bots = await prisma.bot.findMany({
      where: { spaceId: actor.spaceId, archivedAt: null },
      select: { id: true, name: true, instructions: true, homeThreadId: true },
    });
    return bots.find((bot) => bot.id === ref) ?? bots.find((bot) => sameName(bot.name, ref));
  };
  const noDepartment = (ref: string) => ({ error: `No department named "${ref}".` });
  const noBot = (ref: string) => ({ error: `No bot named "${ref}".` });

  switch (change.action) {
    case "create_department": {
      const created = await createDepartmentWithBot(prisma, actor, change.name);
      return {
        type: "access.changed",
        audit: { departmentId: created.id, kind: "department" },
        department: created.name,
        bot: created.botName,
      };
    }
    case "rename_department": {
      const department = await findDepartment(change.department);
      if (!department) return noDepartment(change.department);
      const renamed = await departments.renameDepartment(actor, {
        departmentId: department.id,
        name: change.name,
      });
      return {
        type: "access.changed",
        audit: { departmentId: department.id, kind: "department" },
        department: renamed.name,
      };
    }
    case "remove_department": {
      const department = await findDepartment(change.department);
      if (!department) return noDepartment(change.department);
      await departments.deleteDepartment(actor, { departmentId: department.id });
      return {
        type: "access.changed",
        audit: { departmentId: department.id, kind: "department" },
        removed: department.name,
      };
    }
    case "set_person": {
      const department = await findDepartment(change.department);
      if (!department) return noDepartment(change.department);
      const others = department.users
        .filter((user) => !sameName(user.email, change.email))
        .map((user) => ({ email: user.email, role: user.role }));
      const saved = await departments.setDepartmentUsers(actor, {
        departmentId: department.id,
        users:
          change.role === "none" ? others : [...others, { email: change.email, role: change.role }],
      });
      const target = [...saved.users, ...department.users].find((user) =>
        sameName(user.email, change.email),
      );
      return {
        type: "access.changed",
        audit: {
          departmentId: department.id,
          kind: "department_users",
          role: change.role,
          ...(target ? { targetUserId: target.userId } : {}),
        },
        department: department.name,
        person: change.email,
        role: change.role,
      };
    }
    case "set_department_bot": {
      const [department, bot] = await Promise.all([
        findDepartment(change.department),
        findBot(change.bot),
      ]);
      if (!department) return noDepartment(change.department);
      if (!bot) return noBot(change.bot);
      const current = (await departments.botDepartmentIds(actor, [bot.id])).get(bot.id) ?? [];
      await departments.setBotDepartments(actor, {
        botId: bot.id,
        departmentIds: change.included
          ? [...new Set([...current, department.id])]
          : current.filter((id) => id !== department.id),
      });
      return {
        type: "access.changed",
        audit: { departmentId: department.id, botId: bot.id, kind: "bot_departments" },
        department: department.name,
        bot: bot.name,
        included: change.included,
      };
    }
    case "set_persona_template": {
      await departments.setBotTemplate(actor, change.instructions);
      return { type: "configuration.changed", audit: { kind: "department_persona" } };
    }
    case "set_bot_persona": {
      const bot = await findBot(change.bot);
      if (!bot?.homeThreadId) return noBot(change.bot);
      await commitBotUpdate({
        prisma,
        notify: context.notify ?? (async () => undefined),
        spaceId: actor.spaceId,
        threadId: bot.homeThreadId,
        botId: bot.id,
        emitBotUpdated: true,
        data: { instructions: change.instructions },
        expectedInstructions: bot.instructions,
        reason: "Updated by an admin",
      });
      return {
        type: "configuration.changed",
        audit: { botId: bot.id, kind: "bot_persona" },
        bot: bot.name,
      };
    }
    case "set_connection_departments": {
      const servers = await prisma.mcpServer.findMany({
        where: { spaceId: actor.spaceId, shared: true },
        select: { id: true, name: true, slug: true },
      });
      const server =
        servers.find((row) => row.id === change.connection) ??
        servers.find(
          (row) => sameName(row.name, change.connection) || sameName(row.slug, change.connection),
        );
      if (!server) return { error: `No company connection named "${change.connection}".` };
      const ids: string[] = [];
      for (const ref of change.departments) {
        const department = await findDepartment(ref);
        if (!department) return noDepartment(ref);
        ids.push(department.id);
      }
      await prisma.$transaction(async (tx) => {
        await tx.mcpServerDepartment.deleteMany({ where: { serverId: server.id } });
        await tx.mcpServerDepartment.createMany({
          data: [...new Set(ids)].map((departmentId) => ({ serverId: server.id, departmentId })),
        });
      });
      return {
        type: "access.changed",
        audit: { serverId: server.id, kind: "connection_departments" },
        connection: server.name,
        departments: change.departments.length ? change.departments : "everyone",
      };
    }
    case "set_admin_only": {
      if (!actor.isDeploymentOwner) return { error: "Only the deployment owner can change this." };
      await runAsSystem("the deployment owner changes the admin-only switch", () =>
        prisma.deploymentSettings.update({
          where: { id: "default" },
          data: { connectionsAdminOnly: change.enabled },
        }),
      );
      return {
        type: "deployment.settings.changed",
        audit: { connectionsAdminOnly: change.enabled },
        onlyAdminsAddBotsAndConnections: change.enabled,
      };
    }
  }
}
