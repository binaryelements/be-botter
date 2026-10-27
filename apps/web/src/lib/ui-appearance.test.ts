import { describe, expect, it } from "vitest";
import { applyResolvedAppearance } from "./ui-appearance";

describe("ui-appearance", () => {
  it("writes data-theme and color-scheme on the root", () => {
    const root = {
      dataset: {} as DOMStringMap,
      style: { colorScheme: "" },
    };
    applyResolvedAppearance("dark", root as unknown as HTMLElement);
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
  });
});
