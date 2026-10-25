import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("the deployment owner reads and filters the audit log", async ({ page }, testInfo) => {
  // Signup, onboarding and the settings page use most of the default budget on a slow runner.
  test.slow();
  // In a shared CI database an earlier spec's account already owns the deployment, so this
  // spec stands in for the owner: it flags itself as such and serves a fixed event page. The
  // owner-only RPC itself is covered by the API and Postgres suites.
  const events = [
    { id: "e2", type: "auth.sign_in", createdAt: "2026-10-25T06:00:01.000Z" },
    { id: "e1", type: "auth.sign_up", createdAt: "2026-10-25T06:00:00.000Z" },
  ].map((event) => ({
    ...event,
    userId: "audit-owner",
    spaceId: null,
    ip: null,
    userAgent: null,
    metadata: {},
  }));
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json?: Record<string, unknown> };
    if (body.json) body.json.isDeploymentOwner = true;
    await route.fulfill({ response, json: body });
  });
  await page.route("**/rpc/security/events", async (route) => {
    const body = route.request().postDataJSON() as { json?: { type?: string } } | null;
    const type = body?.json?.type;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: events.filter((event) => !type || event.type === type) }),
    });
  });
  await signup(page, `audit-${Date.now()}@rakazo.test`, "password12", "Audit Owner");
  await completeOnboarding(page);

  const settings = await openUserSettings(page);
  const audit = settings.getByTestId("audit-log");
  await audit.scrollIntoViewIfNeeded();
  await expect(audit).toBeVisible();
  const rows = audit.getByTestId("audit-log-row");
  await expect(rows.first()).toBeVisible();
  await expect(rows.filter({ hasText: /auth\.sign_(up|in)/ }).first()).toBeVisible();

  await audit.getByTestId("audit-log-type").selectOption("auth.sign_in");
  await expect(rows.first()).toContainText("auth.sign_in");
  await expect(rows.filter({ hasText: "auth.sign_up" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "audit-log");
});
