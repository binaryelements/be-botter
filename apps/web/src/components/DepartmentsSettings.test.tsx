// @vitest-environment jsdom
import type { Department } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  departments: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    setUsers: vi.fn(),
  },
  bots: { list: vi.fn(), setDepartments: vi.fn() },
  me: vi.fn(),
}));

vi.mock("../lib/space-rpc", () => ({ useSpaceRpc: () => client }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
}));

import { DepartmentsSettings } from "./DepartmentsSettings";

const head: Department["users"][number] = {
  userId: "user-head",
  email: "head@example.test",
  name: "Hana Head",
  role: "head",
};
const it_: Department = {
  id: "dept-it",
  name: "IT",
  users: [head],
  botIds: ["bot-1"],
  canManageUsers: true,
};

let container: HTMLDivElement;
let root: Root;

async function render(departments: Department[], isSpaceOwner: boolean) {
  client.departments.list.mockResolvedValue(departments);
  client.me.mockResolvedValue({ isSpaceOwner });
  client.bots.list.mockResolvedValue([
    { id: "bot-1", name: "Scout" },
    { id: "bot-2", name: "Painter" },
  ]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<DepartmentsSettings />);
  });
  await act(async () => {});
}

function button(text: string) {
  const found = [...container.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === text,
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

function setValue(input: HTMLInputElement | HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("DepartmentsSettings", () => {
  it("lists departments with their people and lets an owner add one", async () => {
    await render([it_], true);
    expect(container.textContent).toContain("IT");
    expect(container.textContent).toContain("Hana Head");
    expect(container.textContent).toContain("head@example.test");
    const created: Department = {
      id: "dept-accounts",
      name: "Accounts",
      users: [],
      botIds: [],
      canManageUsers: true,
    };
    client.departments.create.mockResolvedValue(created);
    const nameInput = container.querySelector<HTMLInputElement>('input[name="department-name"]');
    if (!nameInput) throw new Error("Missing department name input");
    await act(async () => setValue(nameInput, "Accounts"));
    await act(async () => button("Add department").click());
    expect(client.departments.create).toHaveBeenCalledWith({ name: "Accounts" });
    expect(container.textContent).toContain("Accounts");
    expect(nameInput.value).toBe("");
  });

  it("lets an owner add and remove a department's bots", async () => {
    await render([it_], true);
    const removeButton = (name: string) => container.querySelector(`[aria-label="Remove ${name}"]`);
    expect(removeButton("Scout")).not.toBeNull();
    client.bots.setDepartments.mockResolvedValueOnce({ departmentIds: [] });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Remove Scout"]')?.click(),
    );
    expect(client.bots.setDepartments).toHaveBeenCalledWith({ botId: "bot-1", departmentIds: [] });
    expect(removeButton("Scout")).toBeNull();

    client.bots.setDepartments.mockResolvedValueOnce({ departmentIds: ["dept-it"] });
    const picker = container.querySelector<HTMLSelectElement>('select[aria-label="Bots"]');
    if (!picker) throw new Error("Missing bot picker");
    await act(async () => setValue(picker, "bot-2"));
    await act(async () => button("Add").click());
    expect(client.bots.setDepartments).toHaveBeenLastCalledWith({
      botId: "bot-2",
      departmentIds: ["dept-it"],
    });
    expect(removeButton("Painter")).not.toBeNull();
  });

  it("shows departments read-only to someone who is neither owner nor head", async () => {
    await render([{ ...it_, canManageUsers: false }], false);
    expect(container.textContent).toContain("IT");
    expect(container.textContent).toContain("Hana Head");
    expect(container.querySelector('input[name="department-name"]')).toBeNull();
    expect(container.querySelector('input[type="email"]')).toBeNull();
    expect([...container.querySelectorAll("button")]).toHaveLength(0);
  });

  it("lets a head add a person by email and keeps the current people", async () => {
    await render([it_], false);
    expect(container.querySelector('input[name="department-name"]')).toBeNull();
    client.departments.setUsers.mockResolvedValue({
      ...it_,
      users: [
        head,
        { userId: "user-new", email: "new@example.test", name: "New Person", role: "member" },
      ],
    });
    const email = container.querySelector<HTMLInputElement>('input[type="email"]');
    if (!email) throw new Error("Missing email input");
    await act(async () => setValue(email, "new@example.test"));
    await act(async () => button("Add person").click());
    expect(client.departments.setUsers).toHaveBeenCalledWith({
      departmentId: "dept-it",
      users: [
        { email: "head@example.test", role: "head" },
        { email: "new@example.test", role: "member" },
      ],
    });
    expect(container.textContent).toContain("New Person");
    expect(email.value).toBe("");
  });

  it("changes a person's role and removes them through setUsers", async () => {
    await render(
      [
        {
          ...it_,
          users: [
            head,
            { userId: "user-m", email: "m@example.test", name: "Mo Member", role: "member" },
          ],
        },
      ],
      true,
    );
    client.departments.setUsers.mockImplementation(
      async (input: { users: Array<{ email: string; role: "member" | "head" }> }) => ({
        ...it_,
        users: input.users.map((user) => ({
          userId: user.email === head.email ? head.userId : "user-m",
          name: user.email === head.email ? head.name : "Mo Member",
          email: user.email,
          role: user.role,
        })),
      }),
    );
    const roleSelect = container.querySelector<HTMLSelectElement>(
      'select[data-testid="department-role-user-m"]',
    );
    if (!roleSelect) throw new Error("Missing role select");
    await act(async () => setValue(roleSelect, "head"));
    expect(client.departments.setUsers).toHaveBeenLastCalledWith({
      departmentId: "dept-it",
      users: [
        { email: "head@example.test", role: "head" },
        { email: "m@example.test", role: "head" },
      ],
    });
    const remove = container.querySelector<HTMLButtonElement>(
      'button[data-testid="department-remove-user-m"]',
    );
    if (!remove) throw new Error("Missing remove button");
    await act(async () => remove.click());
    expect(client.departments.setUsers).toHaveBeenLastCalledWith({
      departmentId: "dept-it",
      users: [{ email: "head@example.test", role: "head" }],
    });
  });

  it("removes a department only after confirming", async () => {
    await render([it_], true);
    client.departments.remove.mockResolvedValue({ ok: true });
    await act(async () => button("Remove").click());
    expect(client.departments.remove).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Remove IT?");
    await act(async () => button("Cancel").click());
    expect(container.textContent).not.toContain("Remove IT?");
    await act(async () => button("Remove").click());
    const confirm = container.querySelector<HTMLButtonElement>(
      'button[data-testid="department-remove-confirm-dept-it"]',
    );
    if (!confirm) throw new Error("Missing confirm button");
    await act(async () => confirm.click());
    expect(client.departments.remove).toHaveBeenCalledWith({ departmentId: "dept-it" });
    expect(container.textContent).not.toContain("Hana Head");
  });

  it("shows the server's message when a person cannot be added", async () => {
    await render([it_], true);
    client.departments.setUsers.mockRejectedValue(new Error("No account with the email x"));
    const email = container.querySelector<HTMLInputElement>('input[type="email"]');
    if (!email) throw new Error("Missing email input");
    await act(async () => setValue(email, "x@example.test"));
    await act(async () => button("Add person").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "No account with the email x",
    );
  });
});
