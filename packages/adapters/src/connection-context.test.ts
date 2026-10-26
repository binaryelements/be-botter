import { describe, expect, it } from "vitest";
import { personRunFor, personStartedRun } from "./connection-context.js";

describe("personStartedRun", () => {
  it("counts the person's own message and the routines they made themselves", () => {
    expect(personStartedRun("user", false)).toBe(true);
    expect(personStartedRun("routine", true)).toBe(true);
    // A routine a channel, webhook or another bot got the bot to schedule is not theirs.
    expect(personStartedRun("routine", false)).toBe(false);
    for (const trigger of [
      "messaging",
      "webhook",
      "tickets",
      "bot_message",
      "spawn",
      "follow_up",
      "reaction",
      "call_end",
      "cloud_agent",
    ])
      expect(personStartedRun(trigger, true), trigger).toBe(false);
  });
});

describe("personRunFor", () => {
  const mine = { departmentId: null, groupId: null, userId: "u1" };
  it("is only the person's own private thread", () => {
    expect(personRunFor(true, mine, "u1")).toBe(true);
    expect(personRunFor(false, mine, "u1")).toBe(false);
    // A channel or group thread is read by others, even when the person asked.
    expect(personRunFor(true, { ...mine, departmentId: "d1" }, "u1")).toBe(false);
    expect(personRunFor(true, { ...mine, groupId: "g1" }, "u1")).toBe(false);
    // Someone else's private thread, such as the bot owner's home thread.
    expect(personRunFor(true, { ...mine, userId: "owner" }, "u1")).toBe(false);
  });
});
