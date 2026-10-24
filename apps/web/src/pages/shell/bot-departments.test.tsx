// @vitest-environment jsdom
import type { Department } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({
  departments: { list: vi.fn() },
  bots: { setDepartments: vi.fn() },
}));

vi.mock("../../lib/rpc", () => ({ rpc }));
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
  Switch: ({
    onCheckedChange,
    checked,
    ...props
  }: ComponentProps<"button"> & {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange?.(!checked)}
      {...props}
    />
  ),
}));

import { BotDepartmentsSection } from "./bot-departments";

const departments: Department[] = [
  { id: "dept-it", name: "IT", users: [], botIds: ["bot-1"], canManageUsers: true },
  { id: "dept-accounts", name: "Accounts", users: [], botIds: [], canManageUsers: true },
];

let container: HTMLDivElement;
let root: Root;

const onOpenDepartments = vi.fn();

async function render(list: Department[]) {
  rpc.departments.list.mockResolvedValue(list);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<BotDepartmentsSection botId="bot-1" onOpenDepartments={onOpenDepartments} />);
  });
  await act(async () => {});
}

function switches() {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
}

beforeEach(() => vi.clearAllMocks());

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("BotDepartmentsSection", () => {
  it("shows one switch per department, on for the bot's own", async () => {
    await render(departments);
    expect(container.textContent).toContain("Departments");
    expect(container.textContent).toContain("IT");
    expect(container.textContent).toContain("Accounts");
    expect(switches().map((node) => node.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  });

  it("saves the new set of departments when a switch is flipped", async () => {
    await render(departments);
    rpc.bots.setDepartments.mockResolvedValue({ departmentIds: ["dept-it", "dept-accounts"] });
    await act(async () => switches()[1]!.click());
    expect(rpc.bots.setDepartments).toHaveBeenCalledWith({
      botId: "bot-1",
      departmentIds: ["dept-it", "dept-accounts"],
    });
    expect(switches().map((node) => node.getAttribute("aria-checked"))).toEqual(["true", "true"]);
    rpc.bots.setDepartments.mockResolvedValue({ departmentIds: ["dept-accounts"] });
    await act(async () => switches()[0]!.click());
    expect(rpc.bots.setDepartments).toHaveBeenLastCalledWith({
      botId: "bot-1",
      departmentIds: ["dept-accounts"],
    });
  });

  it("puts a switch back and reports when the save fails", async () => {
    await render(departments);
    rpc.bots.setDepartments.mockRejectedValue(new Error("Only a space owner can do this"));
    await act(async () => switches()[1]!.click());
    expect(switches().map((node) => node.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Only a space owner can do this",
    );
  });

  it("offers the Departments settings when the space has none yet", async () => {
    await render([]);
    expect(container.querySelector('[role="switch"]')).toBeNull();
    const open = container.querySelector<HTMLButtonElement>("button");
    expect(open?.textContent).toBe("Departments");
    await act(async () => open?.click());
    expect(onOpenDepartments).toHaveBeenCalledTimes(1);
  });
});
