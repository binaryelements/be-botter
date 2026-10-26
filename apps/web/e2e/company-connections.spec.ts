import { expect, test } from "@playwright/test";
import type { Department, McpServer } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, expandAdvancedSection, signup } from "./helpers";

test("an owner shares an MCP server with one department, signed in as each person", async ({
  page,
}, testInfo) => {
  // Signup, onboarding and the integrations overlay use most of the default budget.
  test.slow();
  // In a shared CI database another spec's account may own the company space, so this spec
  // stands in for its owner and serves the departments and servers. The API rules are covered
  // by the Postgres suite.
  await page.route("**/rpc/bootstrap", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json?: { me?: Record<string, unknown> } };
    if (body.json?.me) body.json.me.canShareConnections = true;
    await route.fulfill({ response, json: body });
  });
  const departments: Department[] = [
    { id: "dept-sales", name: "Sales", users: [], botIds: [], canManageUsers: true },
    { id: "dept-support", name: "Support", users: [], botIds: [], canManageUsers: true },
  ];
  await page.route("**/rpc/departments/list", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ json: departments }) }),
  );
  const servers: McpServer[] = [];
  await page.route("**/rpc/mcp/servers/list", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ json: servers }) }),
  );
  let created: Record<string, unknown> | null = null;
  await page.route("**/rpc/mcp/servers/create", async (route) => {
    const { json } = route.request().postDataJSON() as { json: Record<string, unknown> };
    created = json;
    const server: McpServer = {
      id: "company-graph",
      spaceId: "company-space",
      slug: "microsoft-graph",
      name: "Microsoft Graph",
      description: "",
      transport: "streamable_http",
      endpoint: "https://mcp.example.test/mcp",
      command: null,
      args: [],
      envKeys: [],
      fileKeys: [],
      headerKeys: [],
      hasSecret: false,
      oauthStatus: "none",
      oauthClientId: null,
      health: { status: "unknown", message: null, toolCount: null, checkedAt: null },
      enabled: true,
      revision: 1,
      shared: true,
      signIn: "person",
      departmentIds: ["dept-sales"],
      createdAt: "2026-10-26T00:00:00.000Z",
      updatedAt: "2026-10-26T00:00:00.000Z",
    };
    servers.push(server);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: server }),
    });
  });

  await signup(page, `company-connections-${Date.now()}@rakazo.test`, "password12", "Owner");
  await completeOnboarding(page);
  await page.getByRole("button", { name: "Connect apps", exact: true }).click();
  await expandAdvancedSection(page.getByTestId("integrations-advanced"));
  await page.getByRole("button", { name: "Manage MCP servers", exact: true }).click();
  await expect(page.getByRole("heading", { name: "MCP servers" })).toBeVisible();

  await page.getByLabel("Server name").fill("Microsoft Graph");
  await page.getByLabel("Server URL").fill("https://mcp.example.test/mcp");
  await expect(page.getByRole("tab", { name: "Each person", exact: true })).toHaveCount(0);
  await page.getByRole("switch", { name: "Share with the company", exact: true }).click();
  await page.getByRole("tab", { name: "Each person", exact: true }).click();
  // Each person signs in with their own account, so no static credential or OAuth client.
  await expect(page.getByRole("button", { name: "Advanced", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Sales", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sales", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await captureScreenshot(page, testInfo, "company-connection-form");

  await page.getByRole("button", { name: "Add server", exact: true }).click();
  await expect(page.getByText("Microsoft Graph", { exact: true })).toBeVisible();
  expect(created).toMatchObject({
    transport: "streamable_http",
    endpoint: "https://mcp.example.test/mcp",
    shared: true,
    signIn: "person",
    departmentIds: ["dept-sales"],
  });
  // Shared servers reach bots through departments and never use their own OAuth.
  await expect(page.getByRole("button", { name: "Connect OAuth", exact: true })).toHaveCount(0);
});
