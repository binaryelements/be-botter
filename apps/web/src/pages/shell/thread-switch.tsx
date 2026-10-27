import { useLingui } from "@lingui/react/macro";
import type { BotThread } from "@rakazo/contracts";
import { OptionSelect } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";

/** Which of a bot's threads is open; empty for the caller's own. Spread into every `threads.*` input. */
export type ThreadScope = { departmentId?: string; userId?: string };

/** `channel` opens that department's channel when the bot's threads arrive (a sidebar link). */
export function useBotThreads(
  botId: string | undefined,
  channel?: string,
): {
  threads: BotThread[];
  thread: BotThread | undefined;
  scope: ThreadScope;
  choose: (threadId: string) => void;
} {
  const [loaded, setLoaded] = useState<{ botId: string; list: BotThread[] }>();
  const [chosen, setChosen] = useState<Record<string, BotThread>>({});

  useEffect(() => {
    if (!botId) return;
    let cancelled = false;
    rpc.bots
      .threads({ botId })
      .then((list) => {
        if (!cancelled) setLoaded({ botId, list });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [botId]);
  const threads = loaded && loaded.botId === botId ? loaded.list : [];

  useEffect(() => {
    if (!botId || !channel || loaded?.botId !== botId) return;
    const entry = loaded.list.find((candidate) => candidate.departmentId === channel);
    if (entry) setChosen((current) => ({ ...current, [botId]: entry }));
  }, [botId, channel, loaded]);

  // The remembered choice stands until the fresh list arrives, so a bot switch does not
  // subscribe to the private thread first and the channel a moment later.
  const remembered = botId ? chosen[botId] : undefined;
  const linked = channel ? threads.find((entry) => entry.departmentId === channel) : undefined;
  const thread = threads.length
    ? (threads.find((entry) => entry.threadId === remembered?.threadId) ?? linked ?? threads[0])
    : remembered;
  const own = threads.length ? thread === threads[0] : thread?.kind === "private" && !thread.name;
  // A channel link targets its channel from the first render: a message typed before the
  // thread list arrives must not land in the private thread.
  const scope: ThreadScope =
    !threads.length && channel
      ? { departmentId: channel }
      : !thread || own
        ? {}
        : thread.departmentId
          ? { departmentId: thread.departmentId }
          : thread.userId
            ? { userId: thread.userId }
            : {};
  return {
    threads,
    thread,
    scope,
    choose: (threadId) => {
      const entry = threads.find((candidate) => candidate.threadId === threadId);
      if (botId && entry) setChosen((current) => ({ ...current, [botId]: entry }));
    },
  };
}

export function ThreadSwitch({
  threads,
  value,
  onChange,
}: {
  threads: BotThread[];
  value: string | undefined;
  onChange: (threadId: string) => void;
}) {
  const { t } = useLingui();
  if (threads.length < 2 || !value) return null;
  return (
    <OptionSelect
      size="sm"
      className="app-no-drag w-auto shrink-0"
      data-testid="thread-channel"
      aria-label={t`Thread`}
      options={threads.map((thread, index) => ({
        value: thread.threadId,
        label: index === 0 ? t`Private` : (thread.name ?? ""),
      }))}
      value={value}
      onValueChange={onChange}
    />
  );
}

/** Who sent a user message in a channel; nothing in other threads or for the viewer's own. */
export function channelSenderName(
  departmentId: string | undefined,
  me: string | undefined,
  names: Record<string, string>,
  threads: BotThread[],
  userId: string | undefined,
): string | undefined {
  if (!departmentId || !userId || userId === me) return undefined;
  return names[userId] || threads.find((thread) => thread.userId === userId)?.name || undefined;
}
