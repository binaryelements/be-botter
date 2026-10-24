import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  expandAdvancedSection,
  signup,
} from "./helpers";

test("an owner shares a bot with a department and its member can reach it", async ({
  page,
  browser,
}, testInfo) => {
  const stamp = Date.now();
  const staffEmail = `departments-staff-${stamp}@rakazo.test`;
  // The staff member has their own account first; the owner then adds them by email.
  const staffContext = await browser.newContext();
  const staffPage = await staffContext.newPage();
  await signup(staffPage, staffEmail, "password12", "IT Staff");
  await completeOnboarding(staffPage);

  await signup(page, `departments-owner-${stamp}@rakazo.test`, "password12", "Owner");
  await completeOnboarding(page);
  const botName = `IT Support ${stamp}`;
  await createNamedBot(page, botName);

  // Departments start from a bot's page: the owner wants to share this bot with a team.
  await page.locator("main").getByRole("button", { name: botName, exact: true }).click();
  const botSettings = page.getByTestId("bot-settings");
  await expect(botSettings).toBeVisible();
  await expandAdvancedSection(botSettings.getByTestId("bot-settings-advanced"));
  await botSettings.getByRole("button", { name: "Departments", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toHaveAttribute("data-settings-section", "departments");
  const panel = settings.getByTestId("departments-settings");
  await panel.getByLabel("New department").fill("IT");
  await panel.getByRole("button", { name: "Add department", exact: true }).click();
  const department = panel.locator('li[data-testid^="department-"]').first();
  await expect(department.getByRole("heading", { name: "IT", exact: true })).toBeVisible();
  await department.getByLabel("Email").fill(staffEmail);
  await department.getByRole("button", { name: "Add person", exact: true }).click();
  await expect(department.getByText(staffEmail)).toBeVisible();
  await captureScreenshot(page, testInfo, "departments-settings");
  await settings.getByRole("button", { name: "Close user settings" }).click();

  // Back on the bot page, the new department shows up as a switch.
  const departments = botSettings.getByTestId("bot-departments");
  const itSwitch = departments.getByRole("switch", { name: "IT", exact: true });
  await expect(itSwitch).not.toBeChecked();
  await itSwitch.click();
  await expect(itSwitch).toBeChecked();
  await captureScreenshot(page, testInfo, "bot-departments");

  // The staff member sees the company's bot beside their own and can open its chat.
  await staffPage.goto("/app");
  const sharedBot = staffPage.getByRole("button", { name: botName }).first();
  await expect(sharedBot).toBeVisible();
  await sharedBot.click();
  await expect(staffPage.getByPlaceholder(`Message ${botName}`)).toBeVisible();
  await captureScreenshot(staffPage, testInfo, "departments-member-chat");
  await staffContext.close();
});
