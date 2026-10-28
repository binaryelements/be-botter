import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("a signed-out visitor is refused a wrong admin key", async ({ page }, testInfo) => {
  await page.route("**/api/auth/get-session**", (route) => route.fulfill({ json: null }));
  await page.route("**/api/auth/sign-in/admin-key", (route) =>
    route.fulfill({
      status: 403,
      json: { code: "WRONG_ADMIN_KEY", message: "Wrong admin key" },
    }),
  );

  await page.goto("/setup");
  await page.getByLabel("Admin key", { exact: true }).fill("f".repeat(64));
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert")).toHaveText("Wrong admin key");
  await captureScreenshot(page, testInfo, "admin-key-refused");
});
