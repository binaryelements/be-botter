import type { Prisma, PrismaClient } from "./generated/prisma/client.js";

type Db = PrismaClient | Prisma.TransactionClient;
type BotRef = { id: string; spaceId: string };

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

async function findOrCreateThread(
  db: Db,
  bot: BotRef,
  where: { userId?: string; departmentId: string | null },
  openedBy: string,
) {
  const key = { botId: bot.id, ...where };
  const existing = await db.thread.findFirst({ where: key, select: { id: true } });
  if (existing) return existing;
  try {
    return await db.thread.create({
      data: {
        spaceId: bot.spaceId,
        botId: bot.id,
        userId: openedBy,
        departmentId: where.departmentId,
      },
      select: { id: true },
    });
  } catch (error) {
    // Two first opens at once: the partial unique index lets one through; use that one.
    if (!isUniqueViolation(error)) throw error;
    return db.thread.findFirstOrThrow({ where: key, select: { id: true } });
  }
}

/** The person's own thread with a bot, created on first use. */
export function privateThread(db: Db, bot: BotRef, userId: string): Promise<{ id: string }> {
  return findOrCreateThread(db, bot, { userId, departmentId: null }, userId);
}

/** The department's shared thread with a bot, created on first open. `openedBy` only records who. */
export function channelThread(
  db: Db,
  bot: BotRef,
  departmentId: string,
  openedBy: string,
): Promise<{ id: string }> {
  return findOrCreateThread(db, bot, { departmentId }, openedBy);
}

/**
 * The bot's home thread: its creator's private thread, where background work (routines,
 * messaging, computer, calls) lands. Heals a bot the previous release created without one.
 */
export async function homeThread(
  db: Db,
  bot: BotRef & { userId: string; homeThreadId: string | null },
): Promise<{ id: string }> {
  if (bot.homeThreadId) return { id: bot.homeThreadId };
  const thread = await privateThread(db, bot, bot.userId);
  await db.bot.update({ where: { id: bot.id }, data: { homeThreadId: thread.id } });
  return thread;
}
