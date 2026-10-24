import type { Actor, BotThread, MessageBlock } from "@rakazo/contracts";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  channelThread,
  channelUnread,
  createRepos,
  isSpaceOwner,
} from "@rakazo/db";

/** Minimal dependency surface for helpers that update a bot's thread cards. */
export type BotThreadDeps = {
  prisma: PrismaClient;
  events: ThreadEvents;
};

/** The bot, access-checked, and the actor's own thread with it (created on first use). */
export async function requireBotThread(deps: BotThreadDeps, actor: Actor, botId: string) {
  const bot = await createRepos(deps.prisma).getBot(actor, botId);
  return { bot, thread: bot.thread };
}

export async function updateBlocks(
  deps: BotThreadDeps,
  target: { spaceId: string; botId: string; threadId: string },
  messageId: string,
  blocks: MessageBlock[],
): Promise<void> {
  const event = await deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.message.update({ where: { id: messageId }, data: { blocks } });
    return appendEventInTransaction(tx, {
      spaceId: target.spaceId,
      threadId: target.threadId,
      botId: target.botId,
      type: "thread.message.updated",
      payload: { messageId, role: "bot", blocks },
    });
  });
  await deps.events.notify(target.threadId, event.seq);
}

/**
 * The threads of a bot the actor may open: their own first, then the channels of their
 * departments (owners: every department the bot is in), then the private threads of the
 * people they supervise, by name. Channels are created here so each entry names a thread.
 */
export async function listBotThreads(
  prisma: PrismaClient,
  actor: Actor,
  botId: string,
): Promise<BotThread[]> {
  const bot = await createRepos(prisma).getBot(actor, botId);
  const owner = isSpaceOwner(actor);
  const departments = await prisma.department.findMany({
    where: {
      spaceId: actor.spaceId,
      bots: { some: { botId: bot.id } },
      ...(owner ? {} : { users: { some: { userId: actor.userId } } }),
    },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      threads: {
        where: { botId: bot.id },
        select: {
          id: true,
          nextMessageSeq: true,
          reads: { where: { userId: actor.userId }, select: { lastReadSeq: true, unread: true } },
        },
      },
      users: { select: { userId: true, role: true } },
    },
  });
  const channels: BotThread[] = [];
  for (const department of departments) {
    const thread = department.threads[0];
    channels.push({
      kind: "channel",
      threadId: thread?.id ?? (await channelThread(prisma, bot, department.id, actor.userId)).id,
      name: department.name,
      departmentId: department.id,
      unread: thread ? channelUnread(thread) : false,
    });
  }
  // Owners supervise everyone with a thread here; a head, the people of the departments they head.
  const supervised = owner
    ? undefined
    : departments
        .filter((d) => d.users.some((u) => u.userId === actor.userId && u.role === "head"))
        .flatMap((d) => d.users.map((u) => u.userId));
  const threads = await prisma.thread.findMany({
    where: {
      botId: bot.id,
      departmentId: null,
      userId: { not: actor.userId, ...(supervised ? { in: supervised } : {}) },
    },
    select: { id: true, userId: true },
  });
  const names = new Map(
    (
      await prisma.user.findMany({
        where: { id: { in: threads.map((thread) => thread.userId) } },
        select: { id: true, name: true },
      })
    ).map((user) => [user.id, user.name]),
  );
  const people: BotThread[] = threads
    .map((thread) => ({
      kind: "private" as const,
      threadId: thread.id,
      name: names.get(thread.userId) ?? "",
      userId: thread.userId,
      unread: false,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [
    { kind: "private", threadId: bot.thread.id, userId: actor.userId, unread: bot.thread.unread },
    ...channels,
    ...people,
  ];
}
