import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("the deployment owner reads and filters the audit log", async ({ page }, testInfo) => {
  // Signup, onboarding and the settings page use most of the default budget on a slow runner.
  test.slow();
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
