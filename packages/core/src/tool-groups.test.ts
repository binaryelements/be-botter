import { BUILTIN_TOOL_NAMES } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  ALWAYS_ON_TOOLS,
  DEFAULT_OFF_GROUPS,
  disabledToolsFor,
  groupsOffFor,
  TOOL_GROUPS,
} from "./tool-groups.js";

describe("tool groups", () => {
  it("places every switchable built-in tool in exactly one group or the always-on list", () => {
    const placed = [...TOOL_GROUPS.flatMap((g) => g.tools), ...ALWAYS_ON_TOOLS];
    expect([...placed].sort()).toEqual([...BUILTIN_TOOL_NAMES].sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  it("turns calls off by default and nothing else", () => {
    expect(disabledToolsFor(DEFAULT_OFF_GROUPS)).toEqual(["call_user", "end_call"]);
    expect(TOOL_GROUPS.filter((g) => !g.defaultOn).map((g) => g.id)).toEqual(["calls"]);
  });

  it("reports a group off only when all its tools are off", () => {
    expect(groupsOffFor(["web_search"])).toEqual([]);
    expect(groupsOffFor(["web_search", "web_fetch", "call_user", "end_call"])).toEqual([
      "web",
      "calls",
    ]);
    expect(groupsOffFor(disabledToolsFor(["files", "media"]))).toEqual(["files", "media"]);
  });
});
