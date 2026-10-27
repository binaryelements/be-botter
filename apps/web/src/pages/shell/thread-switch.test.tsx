// @vitest-environment jsdom
import type { BotThread } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({ bots: { threads: vi.fn() } }));

vi.mock("../../lib/rpc", () => ({ rpc }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => ({
  OptionSelect: ({
    options,
    value,
    onValueChange,
    "data-testid": testId,
  }: {
    options: readonly { value: string; label: string }[];
    value: string;
    onValueChange: (value: string) => void;
    "data-testid"?: string;
  }) => (
    <div>
      <button type="button" data-testid={testId}>
        {options.find((option) => option.value === value)?.label}
      </button>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="option"
          onClick={() => onValueChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  ),
}));

import { channelSenderName, ThreadSwitch, useBotThreads } from "./thread-switch";

const own: BotThread = { kind: "private", threadId: "t-own", userId: "me", unread: false };
const it_: BotThread = {
  kind: "channel",
  threadId: "t-it",
  name: "IT",
  departmentId: "dept-it",
  unread: false,
};
const staff: BotThread = {
  kind: "private",
  threadId: "t-staff",
  name: "IT Staff",
  userId: "user-staff",
  unread: false,
};

function Harness({ botId, channel }: { botId: string; channel?: string }) {
  const { threads, thread, scope, choose } = useBotThreads(botId, channel);
  return (
    <>
      <ThreadSwitch threads={threads} value={thread?.threadId} onChange={choose} />
      <output>{JSON.stringify({ botId, ...scope })}</output>
    </>
  );
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  rpc.bots.threads.mockReset();
});

const target = () => JSON.parse(container.querySelector("output")?.textContent ?? "null");
const options = () =>
  [...container.querySelectorAll('[role="option"]')].map((option) => option.textContent);

it("shows no switch when the bot has only the caller's own thread", async () => {
  rpc.bots.threads.mockResolvedValue([own]);
  await act(async () => root.render(<Harness botId="bot-1" />));
  expect(rpc.bots.threads).toHaveBeenCalledWith({ botId: "bot-1" });
  expect(container.querySelector('[data-testid="thread-channel"]')).toBeNull();
  expect(target()).toEqual({ botId: "bot-1" });
});

it("switches between Private and a department channel", async () => {
  rpc.bots.threads.mockResolvedValue([own, it_]);
  await act(async () => root.render(<Harness botId="bot-1" />));
  const trigger = container.querySelector('[data-testid="thread-channel"]');
  expect(trigger?.textContent).toBe("Private");
  expect(options()).toEqual(["Private", "IT"]);

  await act(async () =>
    container.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]?.click(),
  );
  expect(target()).toEqual({ botId: "bot-1", departmentId: "dept-it" });
  expect(container.querySelector('[data-testid="thread-channel"]')?.textContent).toBe("IT");
});

it("targets a supervised person's thread by userId and remembers the choice per bot", async () => {
  rpc.bots.threads.mockResolvedValue([own, it_, staff]);
  await act(async () => root.render(<Harness botId="bot-1" />));
  await act(async () =>
    container.querySelectorAll<HTMLButtonElement>('[role="option"]')[2]?.click(),
  );
  expect(target()).toEqual({ botId: "bot-1", userId: "user-staff" });

  rpc.bots.threads.mockResolvedValue([own]);
  await act(async () => root.render(<Harness botId="bot-2" />));
  expect(target()).toEqual({ botId: "bot-2" });

  rpc.bots.threads.mockResolvedValue([own, it_, staff]);
  await act(async () => root.render(<Harness botId="bot-1" />));
  expect(target()).toEqual({ botId: "bot-1", userId: "user-staff" });
});

it("targets a sidebar channel link before the bot's threads have loaded", async () => {
  let resolve: (list: BotThread[]) => void = () => undefined;
  rpc.bots.threads.mockReturnValue(new Promise<BotThread[]>((done) => (resolve = done)));
  await act(async () => root.render(<Harness botId="bot-1" channel="dept-it" />));
  // A message sent now must reach the channel the link opened, not the private thread.
  expect(target()).toEqual({ botId: "bot-1", departmentId: "dept-it" });

  await act(async () => resolve([own, it_]));
  expect(target()).toEqual({ botId: "bot-1", departmentId: "dept-it" });
  expect(container.querySelector('[data-testid="thread-channel"]')?.textContent).toBe("IT");
});

const channel = "dept-it";
const names = { "user-staff": "IT Staff" };

it("names other people's messages in a channel only", () => {
  expect(channelSenderName(channel, "me", names, [], "user-staff")).toBe("IT Staff");
  expect(channelSenderName(channel, "me", {}, [own, staff], "user-staff")).toBe("IT Staff");
  expect(channelSenderName(channel, "me", names, [], "me")).toBeUndefined();
  expect(channelSenderName(channel, "me", {}, [], "user-staff")).toBeUndefined();
  expect(channelSenderName(channel, "me", names, [], undefined)).toBeUndefined();
  expect(channelSenderName(undefined, "me", names, [], "user-staff")).toBeUndefined();
});
