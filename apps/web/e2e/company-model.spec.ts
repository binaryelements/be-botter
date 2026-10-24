import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  expandAdvancedSection,
  openUserSettings,
  signup,
} from "./helpers";

test("an owner connects a model for the company and staff run on it", async ({
  page,
  browser,
}, testInfo) => {
  // Two accounts, a department, the model settings and a chat do not fit the default budget.
  test.slow();
  const stamp = Date.now();
  // The first account owns the deployment, so the owner signs up before the staff member.
  await signup(page, `company-model-owner-${stamp}@rakazo.test`, "password12", "Owner");
  await completeOnboarding(page);
  const staffEmail = `company-model-staff-${stamp}@rakazo.test`;
  const staffContext = await browser.newContext();
  const staffPage = await staffContext.newPage();
  await signup(staffPage, staffEmail, "password12", "IT Staff");
  await completeOnboarding(staffPage);
  const botName = `IT Support ${stamp}`;
  await createNamedBot(page, botName);

  // Share the bot with a department the staff member belongs to.
  await page.locator("main").getByRole("button", { name: botName, exact: true }).click();
  const botSettings = page.getByTestId("bot-settings");
  await expect(botSettings).toBeVisible();
  await expandAdvancedSection(botSettings.getByTestId("bot-settings-advanced"));
  await botSettings.getByRole("button", { name: "Departments", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  const panel = settings.getByTestId("departments-settings");
  await panel.getByLabel("New department").fill("IT");
  await panel.getByRole("button", { name: "Add department", exact: true }).click();
  const department = panel.locator('li[data-testid^="department-"]').first();
  await department.getByLabel("Email").fill(staffEmail);
  await department.getByRole("button", { name: "Add person", exact: true }).click();
  await expect(department.getByText(staffEmail)).toBeVisible();
  await settings.getByRole("button", { name: "Close user settings" }).click();
  const itSwitch = botSettings
    .getByTestId("bot-departments")
    .getByRole("switch", { name: "IT", exact: true });
  await itSwitch.click();
  await expect(itSwitch).toBeChecked();

  // The owner connects one key for the whole company; the harness never probes it.
  await openUserSettings(page, "models");
  const company = page.getByTestId("company-model");
  await company.getByTestId("company-model-connect").click();
  await company.getByLabel("Provider").selectOption("openrouter");
  const model = company.getByRole("combobox", { name: "Model", exact: true });
  await model.click();
  await page.getByRole("listbox", { name: "Model options" }).getByRole("option").nth(1).click();
  const chosenModel = await model.textContent();
  await company.getByLabel("API key").fill("sk-or-v1-e2e-company-key-00000000");
  await company.getByRole("button", { name: "Connect API key", exact: true }).click();
  await expect(company.getByTestId("company-model-remove")).toBeVisible();
  await expect(company).toContainText("OpenRouter");
  await expect(company.getByRole("button", { name: "Connect for the company" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "company-model");
  expect(chosenModel).toBeTruthy();

  // Staff reach the shared bot and get a reply with no model setup of their own.
  await staffPage.goto("/app");
  await staffPage.getByRole("button", { name: botName }).first().click();
  const composer = staffPage.getByRole("combobox", { name: `Message ${botName}` });
  await composer.fill("Hello from staff");
  await staffPage.keyboard.press("Enter");
  await expect(
    staffPage.getByTestId("message-user-bubble").getByText("Hello from staff"),
  ).toBeVisible();
  await expect(staffPage.getByTestId("message-bot-bubble").first()).toBeVisible();

  await openUserSettings(staffPage, "models");
  await expect(staffPage.getByTestId("company-model-source")).toHaveText("Company");
  await expect(staffPage.getByTestId("company-model")).toHaveCount(0);
  await captureScreenshot(staffPage, testInfo, "company-model-member");
  await staffContext.close();
});
