// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  me: vi.fn(),
  setup: {
    get: vi.fn(),
    templates: vi.fn(),
    createCompany: vi.fn(),
    addDepartment: vi.fn(),
    setDepartmentTools: vi.fn(),
    update: vi.fn(),
    markReady: vi.fn(),
    reset: vi.fn(),
  },
  mcp: { servers: { list: vi.fn() } },
}));
vi.mock("../lib/rpc", () => ({ rpc: api, rpcForSpace: () => api }));
vi.mock("../lib/auth", () => ({ authClient: { $fetch: vi.fn() } }));
vi.mock("./model-settings/use-model-settings", () => ({ useModelSettings: () => ({}) }));
vi.mock("./model-settings/company-model", () => ({
  CompanyModel: () => <div data-testid="company-model" />,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, i) => `${text}${i > 0 ? String(values[i - 1]) : ""}${part}`, "");
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children?: ReactNode }) => children,
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { SetupWizardPage } from "./SetupWizard";

const empty = {
  companySpaceId: null,
  companyName: null,
  ownerEmail: null,
  readyAt: null,
  signInMode: "invited",
  tenantId: null,
  departments: [],
};
const company = { ...empty, companySpaceId: "space-1", companyName: "Acme" };
const template = {
  id: "accounts",
  department: "Accounts",
  persona: "Accounts assistant",
  instructions: "You help Accounts.",
  routines: [],
};

async function render() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/setup"]}>
        <Routes>
          <Route path="/setup" element={<SetupWizardPage />} />
          <Route path="/app" element={<p>app</p>} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return container;
}

async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const click = (button: Element | null | undefined) =>
  act(async () => {
    (button as HTMLButtonElement).click();
  });
const button = (container: HTMLElement, label: string, last = false) => {
  const matches = [...container.querySelectorAll("button")].filter((b) => b.textContent === label);
  return last ? matches.at(-1) : matches[0];
};
const field = <T extends Element>(container: HTMLElement, label: string) =>
  container.querySelector<T>(`[aria-label="${label}"]`) as T;

beforeEach(() => {
  vi.clearAllMocks();
  api.me.mockResolvedValue({ isDeploymentOwner: true });
  api.setup.templates.mockResolvedValue([template]);
  api.mcp.servers.list.mockResolvedValue([
    { id: "m1", name: "Microsoft 365", shared: true, health: { status: "ok" } },
    { id: "m2", name: "Personal", shared: false, health: { status: "ok" } },
  ]);
});

it("asks anyone but the superadmin for the admin key", async () => {
  api.me.mockResolvedValue({ isDeploymentOwner: false, superadmin: false });
  const container = await render();
  expect(container.querySelector('[aria-label="Admin key"]')).not.toBeNull();
  expect(api.setup.get).not.toHaveBeenCalled();
});

it("opens the wizard for the superadmin", async () => {
  api.me.mockResolvedValue({ isDeploymentOwner: false, superadmin: true });
  api.setup.get.mockResolvedValue(company);
  const container = await render();
  expect(container.querySelector('[aria-label="Admin key"]')).toBeNull();
  expect(api.setup.get).toHaveBeenCalled();
});

it("walks the steps from company to ready", async () => {
  api.setup.get.mockResolvedValue(empty);
  const container = await render();
  expect(container.querySelector("fieldset:disabled")).not.toBeNull();
  expect(container.querySelector('[data-testid="company-model"]')).toBeNull();

  api.setup.createCompany.mockResolvedValue(company);
  await type(field(container, "Company name"), "Acme");
  await click(button(container, "Save"));
  expect(api.setup.createCompany).toHaveBeenCalledWith({ name: "Acme" });
  expect(container.querySelector('[data-testid="company-model"]')).not.toBeNull();
  expect(container.textContent).toContain("Microsoft 365");
  expect(container.textContent).not.toContain("Personal");

  expect(field<HTMLInputElement>(container, "Department name").value).toBe("Accounts");
  expect(field<HTMLTextAreaElement>(container, "Persona").value).toBe("You help Accounts.");
  api.setup.addDepartment.mockResolvedValue({ departmentId: "d1", botId: "b1" });
  api.setup.get.mockResolvedValue({
    ...company,
    departments: [{ id: "d1", name: "Accounts", botId: "b1", botName: "Accounts assistant" }],
  });
  await click(button(container, "Add department"));
  expect(api.setup.addDepartment).toHaveBeenCalledWith({
    name: "Accounts",
    instructions: "You help Accounts.",
    templateId: "accounts",
    disabledTools: ["call_user", "end_call"],
  });
  expect(container.textContent).toContain("Accounts assistant");

  api.setup.update.mockResolvedValue({ ...company, ownerEmail: "owner@example.test" });
  await type(field(container, "Owner email"), "owner@example.test");
  await click(button(container, "Save", true));
  expect(api.setup.update).toHaveBeenCalledWith({ ownerEmail: "owner@example.test" });

  api.setup.markReady.mockResolvedValue({
    ...company,
    ownerEmail: "owner@example.test",
    readyAt: "2026-10-27T00:00:00.000Z",
  });
  await click(button(container, "Mark ready"));
  expect(container.textContent).toContain("Ready for owner@example.test");
});

it("shows why marking ready failed", async () => {
  api.setup.get.mockResolvedValue(company);
  api.setup.markReady.mockRejectedValue(new Error("Add the owner's email first."));
  const container = await render();
  await click(button(container, "Mark ready"));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Add the owner's");
});

it("shows a load failure instead of a blank page", async () => {
  api.setup.get.mockRejectedValue(new Error("Setup is unavailable."));
  const container = await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Setup is unavailable");
});

it("shows a failed connections list instead of an empty one", async () => {
  api.setup.get.mockResolvedValue(company);
  api.mcp.servers.list.mockRejectedValue(new Error("Connections are unavailable."));
  const container = await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Connections are unavailable",
  );
});

it("resets only once the company name is typed exactly", async () => {
  api.setup.get.mockResolvedValue({ ...company, readyAt: "2026-10-27T00:00:00.000Z" });
  const container = await render();
  const confirm = field<HTMLInputElement>(container, "Type Acme to confirm");
  const reset = button(container, "Reset company") as HTMLButtonElement;
  expect(reset.disabled).toBe(true);
  for (const wrong of ["acme", "Acme ", "Acm"]) {
    await type(confirm, wrong);
    expect(reset.disabled).toBe(true);
  }
  await type(confirm, "Acme");
  expect(reset.disabled).toBe(false);

  api.setup.reset.mockResolvedValue(company);
  api.setup.get.mockResolvedValue(company);
  await click(reset);
  expect(api.setup.reset).toHaveBeenCalledWith({ confirmName: "Acme" });
  expect(api.setup.get).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("Mark ready");
  expect(confirm.value).toBe("");
});

const toggle = (container: HTMLElement, label: string, last = false) => {
  const matches = [...container.querySelectorAll<HTMLElement>('[role="switch"]')].filter(
    (el) => el.getAttribute("aria-label") === label,
  );
  return last ? matches.at(-1) : matches[0];
};

it("turns a group off before adding, and changes an existing department's tools", async () => {
  api.setup.get.mockResolvedValue(company);
  const container = await render();
  expect(toggle(container, "Calls")?.getAttribute("aria-checked")).toBe("false");
  expect(toggle(container, "Web")?.getAttribute("aria-checked")).toBe("true");
  await click(toggle(container, "Web"));
  api.setup.addDepartment.mockResolvedValue({ departmentId: "d1", botId: "b1" });
  api.setup.get.mockResolvedValue({
    ...company,
    departments: [
      {
        id: "d1",
        name: "Accounts",
        botId: "b1",
        botName: "Accounts assistant",
        disabledTools: ["call_user", "end_call"],
      },
    ],
  });
  await click(button(container, "Add department"));
  expect(api.setup.addDepartment).toHaveBeenCalledWith(
    expect.objectContaining({
      disabledTools: ["call_user", "end_call", "web_fetch", "web_search"],
    }),
  );

  expect(toggle(container, "Calls", true)?.getAttribute("aria-checked")).toBe("false");
  expect(toggle(container, "Web", true)?.getAttribute("aria-checked")).toBe("true");
  api.setup.setDepartmentTools.mockResolvedValue({ disabledTools: [] });
  await click(toggle(container, "Calls", true));
  expect(api.setup.setDepartmentTools).toHaveBeenCalledWith({
    departmentId: "d1",
    disabledTools: [],
  });
});

it("shows a group off when any of its tools is off", async () => {
  api.setup.get.mockResolvedValue({
    ...company,
    departments: [
      {
        id: "d1",
        name: "Accounts",
        botId: "b1",
        botName: "Accounts assistant",
        disabledTools: ["web_fetch"],
      },
    ],
  });
  const container = await render();
  expect(toggle(container, "Web", true)?.getAttribute("aria-checked")).toBe("false");
  expect(toggle(container, "Calls", true)?.getAttribute("aria-checked")).toBe("true");
});
