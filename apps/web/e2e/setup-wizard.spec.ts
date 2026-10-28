import { expect, test } from "@playwright/test";
import { captureScreenshot, rpc, signup } from "./helpers";

test("the superadmin sets up a company with a department and marks it ready", async ({
  page,
}, testInfo) => {
  test.slow();
  // In a shared CI database an earlier spec's account already owns the deployment, so this
  // spec stands in for the owner via the bootstrap and me responses, as the audit spec does,
  // and serves the setup procedures from a small in-memory company. The owner-only procedures
  // themselves are covered by the API and Postgres suites.
  let spaceId = "";
  const setup = {
    companySpaceId: null as string | null,
    companyName: null as string | null,
    ownerEmail: null as string | null,
    readyAt: null as string | null,
    signInMode: "invited",
    tenantId: null,
    departments: [] as {
      id: string;
      name: string;
      botId: string;
      botName: string;
      disabledTools: string[];
    }[],
  };
  const template = {
    id: "accounts",
    department: "Accounts",
    persona: "Accounts assistant",
    instructions: "You help the Accounts team.",
    routines: [],
  };
  let refuseNextDepartment = false;
  const setDepartmentToolsCalls: string[][] = [];
  await page.route("**/rpc/setup/*", async (route) => {
    const procedure = new URL(route.request().url()).pathname.split("/").pop();
    const input = (route.request().postDataJSON() as { json?: Record<string, string> } | null)
      ?.json;
    if (procedure === "createCompany") {
      setup.companySpaceId = spaceId;
      setup.companyName = input?.name ?? null;
    } else if (procedure === "addDepartment" && refuseNextDepartment) {
      refuseNextDepartment = false;
      await route.fulfill({
        status: 400,
        json: {
          json: {
            defined: false,
            code: "BAD_REQUEST",
            status: 400,
            message: "User computer limit (1) reached",
          },
        },
      });
      return;
    } else if (procedure === "addDepartment") {
      setup.departments.push({
        id: "d1",
        name: input?.name ?? "",
        botId: "b1",
        botName: "Accounts assistant",
        disabledTools: ["call_user", "end_call"],
      });
    } else if (procedure === "setDepartmentTools") {
      const disabledTools = (input?.disabledTools ?? []) as unknown as string[];
      setDepartmentToolsCalls.push(disabledTools);
      setup.departments[0].disabledTools = disabledTools;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ json: { disabledTools } }),
      });
      return;
    } else if (procedure === "update") {
      setup.ownerEmail = input?.ownerEmail ?? null;
    } else if (procedure === "markReady") {
      setup.readyAt = new Date().toISOString();
    }
    const json = procedure === "templates" ? [template] : setup;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ json }) });
  });
  await page.route("**/rpc/bootstrap", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      json?: { me?: Record<string, unknown> };
    };
    if (body.json?.me) body.json.me.isDeploymentOwner = true;
    await route.fulfill({ response, json: body });
  });
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json?: Record<string, unknown> };
    if (body.json) body.json.isDeploymentOwner = true;
    await route.fulfill({ response, json: body });
  });
  await signup(page, `setup-wizard-${Date.now()}@rakazo.test`, "password12", "Setup Owner");
  // The company space stands in as the account's own space; read it explicitly.
  spaceId = (await rpc<{ spaceId: string }>(page, "me", undefined)).spaceId;
  expect(spaceId).not.toBe("");
  await page.goto("/setup");

  await page.getByLabel("Company name").fill("Example Company");
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await page.getByLabel("Template").selectOption({ label: "Accounts" });
  // A refusal stays in view however far down the page the click happened.
  refuseNextDepartment = true;
  await page.getByRole("button", { name: "Add department", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("User computer limit (1) reached");
  await expect(page.getByRole("alert")).toBeInViewport();
  await captureScreenshot(page, testInfo, "setup-wizard-refused");
  await page.getByRole("button", { name: "Add department", exact: true }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Accounts" })).toBeVisible();
  await captureScreenshot(page, testInfo, "setup-wizard-departments");

  const calls = page.getByRole("switch", { name: "Calls" }).last();
  await expect(calls).not.toBeChecked();
  await calls.click();
  await expect(calls).toBeChecked();
  expect(setDepartmentToolsCalls).toEqual([[]]);
  await captureScreenshot(page, testInfo, "setup-wizard-tools");

  await page.getByLabel("Owner email").fill("owner@example.test");
  await page.getByRole("button", { name: "Save", exact: true }).last().click();
  await page.getByRole("button", { name: "Mark ready", exact: true }).click();
  await expect(page.getByText("Ready for owner@example.test")).toBeVisible();
  await captureScreenshot(page, testInfo, "setup-wizard-ready");
});
