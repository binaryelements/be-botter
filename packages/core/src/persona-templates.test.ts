import { describe, expect, it } from "vitest";
import { PERSONA_TEMPLATES, renderPersona } from "./persona-templates.js";

describe("persona templates", () => {
  it("ships one template per starter department", () => {
    expect(PERSONA_TEMPLATES.map((t) => t.id)).toEqual([
      "accounts",
      "sales",
      "operations",
      "it",
      "people",
      "management",
    ]);
    for (const t of PERSONA_TEMPLATES) {
      expect(t.instructions).toContain("{company}");
      expect(t.routines.length).toBeGreaterThan(0);
    }
  });

  it("fills company and department into persona text", () => {
    expect(
      renderPersona("Help {company}'s {department} team", {
        company: "Acme",
        department: "Accounts",
      }),
    ).toBe("Help Acme's Accounts team");
  });
});
