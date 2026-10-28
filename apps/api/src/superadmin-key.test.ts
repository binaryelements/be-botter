import { expect, it } from "vitest";
import { parseSuperadminKey } from "./env.js";

it("accepts any key of at least 12 characters", () => {
  expect(parseSuperadminKey(undefined)).toBeUndefined();
  expect(parseSuperadminKey("a".repeat(64))).toBe("a".repeat(64));
  expect(parseSuperadminKey("Example-Key1")).toBe("Example-Key1");
  expect(() => parseSuperadminKey("Example-Key")).toThrow(/12 characters/);
});
