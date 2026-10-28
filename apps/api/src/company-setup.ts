import { rm } from "node:fs/promises";
import { ORPCError } from "@orpc/server";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { runJobKey } from "@rakazo/adapter-kit";
import {
  archiveBot,
  removePiBotSessions,
  removeStoredArtifacts,
  resolveAgentHomePath,
  toComputerRef,
} from "@rakazo/adapters";
import type { Actor, CompanySetup } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, PERSONA_TEMPLATES, renderPersona } from "@rakazo/core";
import {
  CompanySetupError,
  ComputerLimitError,
  cancelRunsInTransaction,
  createCompanySpace,
  createDepartmentWithBot,
  DepartmentNameConflictError,
  ensureComputerRecord,
  homeThread,
  parseComputerMode,
  readCompanySetup,
  recordSecurityEvent,
  runAsSystem,
  runAsTenant,
  updateCompanySetup,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { syncDepartmentRoutines } from "./department-routines.js";
import type { RouterDeps } from "./router.js";

type Deps = Pick<RouterDeps, "prisma">;

function requireSuperadmin(actor: Actor): void {
  if (!actor.isDeploymentOwner) throw new ORPCError("FORBIDDEN");
}

const dto = (setup: Awaited<ReturnType<typeof readCompanySetup>>): CompanySetup => ({
  ...setup,
  readyAt: setup.readyAt?.toISOString() ?? null,
});

export const read = (deps: Deps) =>
  runAsSystem("read company setup", async () => {
    const setup = await readCompanySetup(deps.prisma);
    // A fresh site points at the superadmin's own Space until the wizard creates the company.
    const personal =
      setup.companySpaceId &&
      (
        await deps.prisma.space.findUnique({
          where: { id: setup.companySpaceId },
          select: { isDefault: true },
        })
      )?.isDefault;
    return personal ? { ...setup, companySpaceId: null, companyName: null } : setup;
  });

export const audit = (
  actor: Actor,
  procedure: string,
  metadata: Record<string, string | boolean> = {},
) =>
  recordSecurityEvent({
    type: "configuration.changed",
    userId: actor.userId,
    metadata: { procedure: `setup.${procedure}`, ...metadata },
  });

/** The company Space, with the actor re-scoped to it: the superadmin's active Space may be their own. */
export async function inCompany<T>(
  deps: Deps,
  actor: Actor,
  fn: (scoped: Actor, setup: CompanySetup & { companySpaceId: string }) => Promise<T>,
): Promise<T> {
  const setup = await read(deps);
  if (!setup.companySpaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Create the company first." });
  }
  const scoped: Actor = { ...actor, spaceId: setup.companySpaceId, spaceRole: "owner" };
  return runAsTenant({ spaceId: setup.companySpaceId, userId: actor.userId }, () =>
    fn(scoped, { ...dto(setup), companySpaceId: setup.companySpaceId as string }),
  );
}

export async function getSetup(deps: Deps, actor: Actor) {
  requireSuperadmin(actor);
  const setup = await read(deps);
  if (!setup.companySpaceId) return { ...dto(setup), departments: [] };
  const rows = await runAsTenant({ spaceId: setup.companySpaceId, userId: actor.userId }, () =>
    deps.prisma.department.findMany({
      where: { spaceId: setup.companySpaceId as string },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        bots: { select: { bot: { select: { id: true, name: true } } } },
      },
    }),
  );
  return {
    ...dto(setup),
    departments: rows.map((row) => ({
      id: row.id,
      name: row.name,
      botId: row.bots[0]?.bot.id ?? null,
      botName: row.bots[0]?.bot.name ?? null,
    })),
  };
}

export function listTemplates(actor: Actor) {
  requireSuperadmin(actor);
  return PERSONA_TEMPLATES.map((template) => ({
    ...template,
    routines: template.routines.map((routine) => ({ ...routine, crons: [...routine.crons] })),
  }));
}

export async function createCompany(deps: Deps, actor: Actor, name: string) {
  requireSuperadmin(actor);
  try {
    await runAsSystem("create the company space", () =>
      createCompanySpace(deps.prisma, { userId: actor.userId }, name),
    );
  } catch (error) {
    if (error instanceof CompanySetupError) {
      throw new ORPCError("CONFLICT", { message: "The company already exists." });
    }
    throw error;
  }
  await audit(actor, "createCompany");
  return dto(await read(deps));
}

export async function addDepartment(
  deps: Deps,
  actor: Actor,
  input: { name: string; instructions: string; templateId?: string },
) {
  requireSuperadmin(actor);
  const template = input.templateId
    ? PERSONA_TEMPLATES.find((candidate) => candidate.id === input.templateId)
    : undefined;
  if (input.templateId && !template) {
    throw new ORPCError("BAD_REQUEST", { message: "Unknown template." });
  }
  const result = await inCompany(deps, actor, async (scoped, setup) => {
    const values = { company: setup.companyName ?? "", department: input.name };
    let department: Awaited<ReturnType<typeof createDepartmentWithBot>>;
    try {
      department = await createDepartmentWithBot(deps.prisma, scoped, input.name, {
        instructions: renderPersona(input.instructions, values),
      });
    } catch (error) {
      if (error instanceof DepartmentNameConflictError) {
        throw new ORPCError("CONFLICT", { message: error.message });
      }
      if (error instanceof ComputerLimitError) {
        throw new ORPCError("BAD_REQUEST", { message: error.message });
      }
      throw error;
    }
    const botId = department.botIds[0] as string;
    if (template) {
      const user = await deps.prisma.user.findUnique({
        where: { id: actor.userId },
        select: { timezone: true },
      });
      await deps.prisma.routine.createMany({
        data: template.routines.map((routine) => ({
          spaceId: scoped.spaceId,
          botId,
          userId: actor.userId,
          name: routine.name,
          prompt: renderPersona(routine.prompt, values),
          crons: routine.crons,
          timezone: user?.timezone ?? "UTC",
          active: false,
          personCreated: false,
          runsAsDepartmentHead: true,
          waitingForHead: true,
          nextRunAt: null,
          notify: true,
        })),
      });
    }
    return { departmentId: department.id, botId };
  });
  await audit(actor, "addDepartment", { templateId: input.templateId ?? "" });
  return result;
}

export async function updateSetup(
  deps: Deps,
  actor: Actor,
  input: { ownerEmail?: string; signInMode?: "invited" | "organisation" },
) {
  requireSuperadmin(actor);
  await runAsSystem("update company setup", () => updateCompanySetup(deps.prisma, input));
  await audit(actor, "update", { signInMode: input.signInMode ?? "" });
  return dto(await read(deps));
}

export async function markReady(deps: Deps, actor: Actor) {
  requireSuperadmin(actor);
  const setup = await read(deps);
  if (!setup.ownerEmail) {
    throw new ORPCError("BAD_REQUEST", { message: "Add the owner's email first." });
  }
  const departments = setup.companySpaceId
    ? await runAsTenant({ spaceId: setup.companySpaceId, userId: actor.userId }, () =>
        deps.prisma.department.count({ where: { spaceId: setup.companySpaceId as string } }),
      )
    : 0;
  if (departments === 0) {
    throw new ORPCError("BAD_REQUEST", { message: "Add at least one department first." });
  }
  await runAsSystem("mark the company ready", () =>
    updateCompanySetup(deps.prisma, { readyAt: new Date() }),
  );
  await audit(actor, "markReady");
  return dto(await read(deps));
}

type ResetDeps = Pick<
  RouterDeps,
  "prisma" | "auth" | "jobs" | "sandbox" | "home" | "artifacts" | "dataDir" | "takeResetBackup"
>;

/**
 * Returns the company to its prepared setup: its people other than the superadmin and all its
 * threads, memory and files go; departments, bots, personas, routines, model and connections stay.
 */
export async function reset(deps: ResetDeps, actor: Actor, confirmName: string) {
  requireSuperadmin(actor);
  const setup = await read(deps);
  const spaceId = setup.companySpaceId;
  if (!spaceId || confirmName !== setup.companyName) {
    throw new ORPCError("BAD_REQUEST", { message: "Type the company name to confirm." });
  }
  let backup: string;
  try {
    if (!deps.takeResetBackup) throw new Error("reset backups are not configured");
    backup = await deps.takeResetBackup();
  } catch (error) {
    getLogger().error("company reset backup failed", error);
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "The backup failed, so nothing was reset.",
    });
  }
  const context = (botId?: string): AdapterContext => ({
    operationId: `setup-reset:${spaceId}`,
    traceId: `setup-reset:${spaceId}`,
    spaceId,
    userId: actor.userId,
    ...(botId ? { botId } : {}),
    signal: new AbortController().signal,
  });
  await audit(actor, "reset", { backup, outcome: "started" });
  try {
    const departmentIds = await runAsSystem("reset the company", () =>
      wipeCompany(deps, actor, spaceId, context),
    );
    for (const departmentId of departmentIds) await syncDepartmentRoutines(deps, departmentId);
  } catch (error) {
    await audit(actor, "reset", { backup, outcome: "failed" });
    throw error;
  }
  await audit(actor, "reset", { backup, outcome: "completed" });
  return dto(await read(deps));
}

async function wipeCompany(
  deps: ResetDeps,
  actor: Actor,
  spaceId: string,
  context: (botId?: string) => AdapterContext,
): Promise<string[]> {
  const { prisma } = deps;
  // Nothing keeps working while its data goes.
  const active = await prisma.run.findMany({
    where: { spaceId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    select: { id: true, taskId: true },
  });
  await prisma.$transaction((tx) => cancelRunsInTransaction(tx, active, new Date()));
  await Promise.allSettled(active.map((run) => deps.jobs.cancel(runJobKey(run.id))));
  const bots = await prisma.bot.findMany({
    where: { spaceId, departments: { some: {} } },
    select: {
      id: true,
      spaceId: true,
      userId: true,
      name: true,
      archivedAt: true,
      pinned: true,
      computerId: true,
      computer: { select: { scope: true, kind: true } },
    },
  });
  const botIds = bots.map((bot) => bot.id);
  for (const bot of bots) {
    // Archiving stops the bot's runs, routine wakeups and computer; the bot itself stays.
    await archiveBot(deps, bot, context(bot.id));
    await prisma.bot.update({
      where: { id: bot.id },
      data: { archivedAt: bot.archivedAt, pinned: bot.pinned },
    });
    await removePiBotSessions(deps.dataDir, bot.userId, bot.id);
  }
  // A department bot someone else made becomes the superadmin's, so deleting that person keeps it.
  await prisma.bot.updateMany({ where: { id: { in: botIds } }, data: { userId: actor.userId } });
  await prisma.routine.updateMany({
    where: { botId: { in: botIds } },
    data: { userId: actor.userId },
  });

  const people = await prisma.spaceMember.findMany({
    where: { spaceId, userId: { not: actor.userId } },
    select: { userId: true },
  });
  for (const person of people) await deps.auth.deleteAccount(person.userId);

  // Every computer in the company Space holds the trial's files and browser sessions.
  for (const computer of await prisma.computer.findMany({ where: { spaceId } })) {
    if (computer.providerRef) {
      await deps.sandbox.destroy(toComputerRef(computer), context()).catch(() => undefined);
    }
    await prisma.computer.delete({ where: { id: computer.id } });
    await rm(resolveAgentHomePath(deps.home, computer.homeKey, deps.dataDir), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
  }

  const storageKeys = await prisma.$transaction(async (tx) => {
    const artifacts = await tx.artifact.findMany({
      where: { spaceId },
      select: { storageKey: true },
    });
    await tx.artifact.deleteMany({ where: { spaceId } });
    await tx.memoryDocument.deleteMany({ where: { spaceId } });
    // Runs, tasks, messages and events go with their threads; group members with their groups;
    // tickets and comments with the board, which is created again on first use.
    await tx.thread.deleteMany({ where: { spaceId } });
    await tx.chatGroup.deleteMany({ where: { spaceId } });
    await tx.board.deleteMany({ where: { spaceId } });
    await tx.spaceInvitation.deleteMany({ where: { spaceId } });
    await tx.agentSkill.deleteMany({ where: { spaceId } });
    await tx.taughtSkill.deleteMany({ where: { spaceId } });
    await tx.scratchpadItem.deleteMany({ where: { spaceId } });
    await tx.cloudAgent.deleteMany({ where: { spaceId } });
    await tx.externalConversation.deleteMany({ where: { spaceId } });
    await tx.messagingIdentity.deleteMany({ where: { spaceId } });
    await tx.messagingLinkCode.deleteMany({ where: { spaceId } });
    await tx.browserProfile.deleteMany({ where: { spaceId } });
    await tx.agentHome.deleteMany({ where: { spaceId } });
    // Deleted people's rows that have no foreign key to their account.
    const theirs = { spaceId, userId: { not: actor.userId } };
    await tx.connection.deleteMany({ where: theirs });
    await tx.capabilityInstall.deleteMany({ where: theirs });
    await tx.notificationPreference.deleteMany({ where: theirs });
    await tx.mcpOAuthSession.deleteMany({ where: theirs });
    return artifacts.map((artifact) => artifact.storageKey);
  });
  await removeStoredArtifacts(deps.artifacts, storageKeys, context());

  // Each department bot starts again as a new bot does: home thread, browser profile, computer.
  for (const bot of bots) {
    await homeThread(prisma, { ...bot, userId: actor.userId, homeThreadId: null });
    await prisma.browserProfile.create({ data: { spaceId, botId: bot.id, userId: actor.userId } });
    if (!bot.computer) continue;
    const computer = await ensureComputerRecord(prisma, {
      mode: parseComputerMode(bot.computer.scope),
      spaceId,
      userId: actor.userId,
      botId: bot.id,
      kind: bot.computer.kind,
    });
    await prisma.bot.update({ where: { id: bot.id }, data: { computerId: computer.id } });
  }
  await updateCompanySetup(prisma, { tenantId: null });
  const departments = await prisma.department.findMany({
    where: { spaceId },
    select: { id: true },
  });
  return departments.map((department) => department.id);
}
