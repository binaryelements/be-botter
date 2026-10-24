import { describe, expect, it } from "vitest";
import { ThreadTargetInput } from "./rpc.js";

describe("ThreadTargetInput", () => {
  it("names a bot's private thread, a department channel, or a person's thread", () => {
    expect(ThreadTargetInput.parse({ botId: "bot-1" })).toEqual({ botId: "bot-1" });
    expect(ThreadTargetInput.parse({ botId: "bot-1", departmentId: "dept-1" })).toEqual({
      botId: "bot-1",
      departmentId: "dept-1",
    });
    expect(ThreadTargetInput.parse({ botId: "bot-1", userId: "user-2" })).toEqual({
      botId: "bot-1",
      userId: "user-2",
    });
    expect(ThreadTargetInput.parse({ groupId: "group-1" })).toEqual({ groupId: "group-1" });
  });

  it("rejects a channel or person without a bot, or both at once", () => {
    expect(() => ThreadTargetInput.parse({ groupId: "group-1", departmentId: "dept-1" })).toThrow(
      /departmentId or userId needs botId, not both/,
    );
    expect(() => ThreadTargetInput.parse({ groupId: "group-1", userId: "user-2" })).toThrow(
      /departmentId or userId needs botId, not both/,
    );
    expect(() =>
      ThreadTargetInput.parse({ botId: "bot-1", departmentId: "dept-1", userId: "user-2" }),
    ).toThrow(/departmentId or userId needs botId, not both/);
    expect(() => ThreadTargetInput.parse({})).toThrow(/exactly one of botId or groupId/);
  });
});
