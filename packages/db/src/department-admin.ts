import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { readConnectionsSwitch } from "./company-space.js";
import type { DepartmentView } from "./departments.js";
import { createDepartmentRepos, departmentBotInstructions } from "./departments.js";
import { createRepos } from "./repos.js";

/**
 * The person as an admin of the space: its owner, or the deployment owner. Null for everyone
 * else. Runs know only a user and a space, so this rebuilds the actor the API would have.
 */
export async function adminActorFor(
  prisma: PrismaClient,
  scope: { spaceId: string; userId: string },
): Promise<Actor | null> {
  const [user, member, settings] = await Promise.all([
    prisma.user.findUnique({ where: { id: scope.userId }, select: { email: true } }),
    prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: scope.spaceId, userId: scope.userId } },
      select: { role: true },
    }),
    readConnectionsSwitch(prisma),
  ]);
  const isDeploymentOwner = settings?.ownerUserId === scope.userId;
  if (!user || (!isDeploymentOwner && member?.role !== "owner")) return null;
  return {
    userId: scope.userId,
    spaceId: scope.spaceId,
    email: user.email,
    isDeploymentOwner,
    ...(member ? { spaceRole: member.role } : {}),
  };
}

/** Create a department with its own bot, whose persona comes from `options.instructions`, else the space's template. */
export async function createDepartmentWithBot(
  prisma: PrismaClient,
  actor: Actor,
  name: string,
  options: { instructions?: string } = {},
): Promise<DepartmentView & { botName: string }> {
  const departments = createDepartmentRepos(prisma);
  const department = await departments.createDepartment(actor, { name });
  const bot = await createRepos(prisma).createBot(actor, {
    name: `${department.name} Assistant`,
    title: "",
    description: "",
    instructions:
      options.instructions ??
      departmentBotInstructions(await departments.botTemplate(actor), department.name),
    notifyOnFinish: true,
  });
  await departments.setBotDepartments(actor, { botId: bot.id, departmentIds: [department.id] });
  return { ...department, botIds: [bot.id], botName: bot.name };
}
