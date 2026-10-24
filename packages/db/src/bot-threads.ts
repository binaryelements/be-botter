import type { Actor } from "@rakazo/contracts";
import { isSpaceOwner } from "./departments.js";
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

type ChannelReadState = {
  nextMessageSeq: number;
  reads: Array<{ lastReadSeq: number; unread: boolean }>;
};

/**
 * Whether a channel is unread for the one reader whose row was selected: behind its newest
 * message, or marked unread by hand. A channel never opened is unread once it has a message.
 */
export function channelUnread(thread: ChannelReadState): boolean {
  const latestSeq = thread.nextMessageSeq - 1;
  if (latestSeq < 0) return false;
  const read = thread.reads[0];
  return read ? read.unread || read.lastReadSeq < latestSeq : true;
}

/** The bots among `botIds` with a channel the actor may open and has not read. */
export async function botsWithUnreadChannels(
  db: Db,
  actor: Actor,
  botIds: string[],
): Promise<Set<string>> {
  if (botIds.length === 0) return new Set();
  const channels = await db.thread.findMany({
    where: {
      botId: { in: botIds },
      departmentId: { not: null },
      nextMessageSeq: { gt: 0 },
      ...(isSpaceOwner(actor) ? {} : { department: { users: { some: { userId: actor.userId } } } }),
    },
    select: {
      botId: true,
      nextMessageSeq: true,
      reads: { where: { userId: actor.userId }, select: { lastReadSeq: true, unread: true } },
    },
  });
  return new Set(
    channels.filter(channelUnread).flatMap((channel) => (channel.botId ? [channel.botId] : [])),
  );
}
