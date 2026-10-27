import { routineWakeupJob } from "@rakazo/adapter-kit";
import { privateThread, runAsSystem } from "@rakazo/db";
import type { RouterDeps } from "./router.js";
import { nextRoutineDate } from "./routine-schedule.js";

type Deps = Pick<RouterDeps, "prisma" | "jobs">;

/** Routines run with no one present and Microsoft 365 only answers a person run, so a department's routines run as its head. */
export async function syncDepartmentRoutines(deps: Deps, departmentId: string): Promise<void> {
  await syncBotRoutines(deps, await departmentBotIds(deps, departmentId));
}

/** A head who signs in (again) has a token now, so their departments' routines can run as them. */
export async function syncHeadRoutines(deps: Deps, userId: string): Promise<void> {
  const departments = await runAsSystem("read headed departments", () =>
    deps.prisma.departmentUser.findMany({
      where: { userId, role: "head" },
      select: { departmentId: true },
    }),
  );
  for (const { departmentId } of departments) await syncDepartmentRoutines(deps, departmentId);
}

export const departmentBotIds = (deps: Deps, departmentId: string) =>
  runAsSystem("read department bots", async () =>
    (
      await deps.prisma.departmentBot.findMany({ where: { departmentId }, select: { botId: true } })
    ).map((link) => link.botId),
  );

/** After a department is deleted: its former bots follow whichever departments they still belong to. */
export const stopHeadRoutines = syncBotRoutines;

/** A bot's head is the earliest head with a stored SSO token across all its departments. */
async function syncBotRoutines(deps: Deps, botIds: string[]): Promise<void> {
  const { prisma } = deps;
  const wakeups = await runAsSystem("sync department routines", async () => {
    const bots = await prisma.bot.findMany({
      where: { id: { in: botIds } },
      select: { id: true, spaceId: true, userId: true },
    });
    const queued: { id: string; at: Date }[] = [];
    for (const bot of bots) {
      const routines = await prisma.routine.findMany({
        where: { botId: bot.id, runsAsDepartmentHead: true },
      });
      if (routines.length === 0) continue;
      const heads = await prisma.departmentUser.findMany({
        where: { role: "head", department: { bots: { some: { botId: bot.id } } } },
        orderBy: { createdAt: "asc" },
        select: { userId: true },
      });
      const withToken = await prisma.secret.findMany({
        where: { kind: "sso-token", spaceId: null, userId: { in: heads.map((h) => h.userId) } },
        select: { userId: true },
      });
      const have = new Set(withToken.map((s) => s.userId));
      const head = heads.find((h) => have.has(h.userId))?.userId;
      if (!head) {
        const owner = { userId: bot.userId, threadId: null, personCreated: false, nextRunAt: null };
        // A routine an admin paused stays paused; only running or waiting ones wait for the next head.
        await prisma.routine.updateMany({
          where: {
            botId: bot.id,
            runsAsDepartmentHead: true,
            OR: [{ active: true }, { waitingForHead: true }],
          },
          data: { ...owner, active: false, waitingForHead: true },
        });
        await prisma.routine.updateMany({
          where: { botId: bot.id, runsAsDepartmentHead: true },
          data: owner,
        });
        continue;
      }
      const thread = await privateThread(prisma, bot, head);
      for (const routine of routines) {
        const active = routine.active || routine.waitingForHead;
        // Already running as this head: keep its schedule so a repeat sync changes nothing.
        const unchanged =
          routine.active && routine.userId === head && routine.threadId === thread.id;
        const nextRunAt = !active
          ? null
          : unchanged && routine.nextRunAt
            ? routine.nextRunAt
            : nextRoutineDate(routine.crons, routine.timezone);
        await prisma.routine.update({
          where: { id: routine.id },
          data: {
            userId: head,
            threadId: thread.id,
            personCreated: true,
            active,
            waitingForHead: false,
            nextRunAt,
          },
        });
        if (nextRunAt && !unchanged) queued.push({ id: routine.id, at: nextRunAt });
      }
    }
    return queued;
  });
  for (const { id, at } of wakeups) await deps.jobs.enqueue(routineWakeupJob(id, at));
}
