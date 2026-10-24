const api = vi.hoisted(() => ({
  rpc: vi.fn(),
  currentApiBase: () => "https://api.example.test",
  selectedSpaceId: vi.fn(() => "space-1"),
}));
vi.mock("./api", () => api);
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));

import type { BotThread } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { botThreadScope, channelSenderName, loadDepartments } from "./bot-threads";

const threads: BotThread[] = [
  { kind: "private", threadId: "t-own", unread: false },
  { kind: "channel", threadId: "t-sales", departmentId: "d-sales", name: "Sales", unread: true },
  { kind: "private", threadId: "t-bob", userId: "u-bob", name: "Bob", unread: false },
];

describe("botThreadScope", () => {
  it("reads a channel or a person from route params and ignores empty values", () => {
    expect(botThreadScope({})).toBeUndefined();
    expect(botThreadScope({ departmentId: "", userId: "" })).toBeUndefined();
    expect(botThreadScope({ departmentId: "d-sales" })).toEqual({ departmentId: "d-sales" });
    expect(botThreadScope({ userId: "u-bob" })).toEqual({ userId: "u-bob" });
  });
});

describe("channelSenderName", () => {
  const users = [{ userId: "u-ann", name: "Ann" }];
  it("names another person's message in a channel", () => {
    expect(
      channelSenderName(
        { role: "user", userId: "u-ann" },
        { me: "u-me", departmentId: "d-sales", users, threads },
      ),
    ).toBe("Ann");
  });
  it("falls back to the supervised people list, then to nothing", () => {
    const context = { me: "u-me", departmentId: "d-sales", users, threads };
    expect(channelSenderName({ role: "user", userId: "u-bob" }, context)).toBe("Bob");
    expect(channelSenderName({ role: "user", userId: "u-zed" }, context)).toBeUndefined();
  });
  it("shows nothing for my own, bot, unattributed, or non-channel messages", () => {
    const context = { me: "u-me", departmentId: "d-sales", users, threads };
    expect(channelSenderName({ role: "user", userId: "u-me" }, context)).toBeUndefined();
    expect(channelSenderName({ role: "bot", userId: "u-ann" }, context)).toBeUndefined();
    expect(channelSenderName({ role: "user" }, context)).toBeUndefined();
    expect(
      channelSenderName({ role: "user", userId: "u-ann" }, { ...context, departmentId: undefined }),
    ).toBeUndefined();
  });
});

describe("loadDepartments", () => {
  beforeEach(() => {
    api.rpc.mockReset();
  });
  it("fetches the space's departments once and shares the result", async () => {
    api.rpc.mockResolvedValue([{ id: "d-sales", name: "Sales", users: [], botIds: [] }]);
    const [first, second] = await Promise.all([loadDepartments(), loadDepartments()]);
    expect(first).toBe(second);
    expect(api.rpc).toHaveBeenCalledTimes(1);
    expect(api.rpc).toHaveBeenCalledWith("departments/list");
  });
  it("forgets a failed fetch so the next open retries", async () => {
    api.rpc.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([]);
    api.selectedSpaceId.mockReturnValue("space-2");
    await expect(loadDepartments()).rejects.toThrow("offline");
    await expect(loadDepartments()).resolves.toEqual([]);
    expect(api.rpc).toHaveBeenCalledTimes(2);
  });
});
