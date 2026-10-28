import { expect, it } from "vitest";
import { parseSuperadminKey } from "./env.js";

it("accepts only a 64-hex key", () => {
  expect(parseSuperadminKey(undefined)).toBeUndefined();
  expect(parseSuperadminKey("a".repeat(64))).toBe("a".repeat(64));
  expect(() => parseSuperadminKey("short")).toThrow(/64 hex/);
});
