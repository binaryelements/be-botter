import type { CompanyModelConnection } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { MobileMe, MobileModelCredential } from "./api";
import { activeModelSourceLabel } from "./company-model";

const t = (message: string) => message;
const me = { defaultProvider: "anthropic", defaultModel: "claude" } as MobileMe;
const company: CompanyModelConnection = {
  provider: "anthropic",
  modelId: "claude",
  thinkingLevel: null,
  label: "Claude",
  supportsImages: true,
  canManage: false,
};
const own = [{ provider: "anthropic" }] as MobileModelCredential[];

describe("activeModelSourceLabel", () => {
  it("names the company when the person has no connection of their own", () => {
    expect(activeModelSourceLabel(me, [], company, "Anthropic", t)).toBe("Company");
  });

  it("names the provider when the person's own connection is the default", () => {
    expect(activeModelSourceLabel(me, own, company, "Anthropic", t)).toBe("Anthropic");
  });

  it("ignores a company connection for another provider", () => {
    expect(activeModelSourceLabel(me, [], { ...company, provider: "openai" }, "Anthropic", t)).toBe(
      "Anthropic",
    );
  });

  it("falls back to the provider id, then the deployment", () => {
    expect(activeModelSourceLabel(me, [], null, undefined, t)).toBe("anthropic");
    expect(activeModelSourceLabel(null, [], null, undefined, t)).toBe("Configured by deployment");
  });
});
