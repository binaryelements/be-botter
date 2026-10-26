import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  chooseOption,
  completeOnboarding,
  createNamedBot,
  expandAdvancedSection,
  openUserSettings,
  signup,
} from "./helpers";

test("an owner sets up a department's people and bots from Settings", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `departments-admin-${stamp}@rakazo.test`, "password12", "Owner");
  await completeOnboarding(page);
  const botName = `Helpdesk ${stamp}`;
  await createNamedBot(page, botName);

  // Owners reach Departments before any department exists.
  const settings = await openUserSettings(page, "departments");
  const panel = settings.getByTestId("departments-settings");
  await panel.getByLabel("New department").fill("IT");
  await panel.getByRole("button", { name: "Add department", exact: true }).click();
  const department = panel.locator('li[data-testid^="department-"]').first();
  await expect(department.getByRole("heading", { name: "IT", exact: true })).toBeVisible();
  // Each department starts with its own bot.
  await expect(department.getByRole("button", { name: "Remove IT Assistant" })).toBeVisible();
  await department.getByRole("combobox", { name: "Bots" }).selectOption({ label: botName });
  await department.getByRole("button", { name: "Add", exact: true }).click();
  await expect(department.getByRole("button", { name: `Remove ${botName}` })).toBeVisible();
  await captureScreenshot(page, testInfo, "departments-admin");

  // The persona new department bots start from.
  await panel.getByText("Department bot persona", { exact: true }).click();
  const persona = panel.getByRole("textbox", { name: "Department bot persona" });
  await expect(persona).toHaveValue(/\{department\}/);
  await persona.fill("You help the {department} team.");
  await persona.blur();
  await panel.getByLabel("New department").fill("Sales");
  await panel.getByRole("button", { name: "Add department", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Remove Sales Assistant" })).toBeVisible();
  await captureScreenshot(page, testInfo, "departments-persona");

  // On a phone the email field keeps a usable width; the buttons wrap below it.
  await page.setViewportSize({ width: 390, height: 844 });
  const email = department.getByLabel("Email");
  await expect.poll(async () => (await email.boundingBox())?.width ?? 0).toBeGreaterThan(180);
  await email.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "departments-phone");
});

test("an owner shares a bot with a department and its member can reach it", async ({
  page,
  browser,
}, testInfo) => {
  // Two accounts, a department and three thread views do not fit the default budget.
  test.slow();
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

  // Staff write to the bot privately, then to the whole department in its channel.
  const staffComposer = staffPage.getByRole("combobox", { name: `Message ${botName}` });
  await staffComposer.fill("Private note");
  await staffPage.keyboard.press("Enter");
  await expect(
    staffPage.getByTestId("message-user-bubble").getByText("Private note"),
  ).toBeVisible();
  const staffThreads = staffPage.getByTestId("thread-channel");
  await expect(staffThreads).toHaveText("Private");
  await chooseOption(staffThreads, "IT");
  await expect(staffThreads).toHaveText("IT");
  await expect(staffPage.getByTestId("message-user-bubble")).toHaveCount(0);
  await staffComposer.fill("Team question");
  await staffPage.keyboard.press("Enter");
  await expect(
    staffPage.getByTestId("message-user-bubble").getByText("Team question"),
  ).toBeVisible();

  // The owner reads the channel with the sender named, and the staff member's private
  // thread without a composer.
  await page.reload();
  const ownerThreads = page.getByTestId("thread-channel");
  await expect(ownerThreads).toHaveText("Private");
  await chooseOption(ownerThreads, "IT");
  await expect(ownerThreads).toHaveText("IT");
  await expect(page.getByTestId("message-user-bubble").getByText("Team question")).toBeVisible();
  await expect(page.getByTestId("message-sender")).toHaveText("IT Staff");
  await captureScreenshot(page, testInfo, "departments-channel");
  await chooseOption(ownerThreads, "IT Staff");
  await expect(page.getByTestId("message-user-bubble").getByText("Private note")).toBeVisible();
  await expect(page.getByRole("combobox", { name: `Message ${botName}` })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "departments-supervised");
  await staffContext.close();
});
