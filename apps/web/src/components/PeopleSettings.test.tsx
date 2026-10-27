// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  company: { signInMode: { get: vi.fn(), set: vi.fn() } },
  invitations: { list: vi.fn(), create: vi.fn(), revoke: vi.fn() },
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
  Checkbox: ({
    onCheckedChange,
    ...props
  }: Omit<ComponentProps<"input">, "onChange"> & { onCheckedChange?: (v: boolean) => void }) => (
    <input type="checkbox" onChange={(e) => onCheckedChange?.(e.target.checked)} {...props} />
  ),
  Switch: ({
    onCheckedChange,
    checked,
    ...props
  }: Omit<ComponentProps<"input">, "onChange"> & { onCheckedChange?: (v: boolean) => void }) => (
    <input
      type="checkbox"
      role="switch"
      aria-checked={checked}
      checked={checked}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
      {...props}
    />
  ),
}));

import { PeopleSettings } from "./PeopleSettings";

let container: HTMLDivElement;
let root: Root;

const setValue = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

beforeEach(async () => {
  client.company.signInMode.get.mockResolvedValue({
    mode: "invited",
    ready: true,
    departments: [{ id: "dept-1", name: "Accounts" }],
  });
  client.company.signInMode.set.mockResolvedValue({ mode: "organisation" });
  client.invitations.list.mockResolvedValue([
    { id: "inv-1", email: "old@acme.test", departments: [], acceptedAt: null },
  ]);
  client.invitations.create.mockResolvedValue({
    invitation: { id: "inv-2", email: "new@acme.test", departments: [], acceptedAt: null },
    signInUrl: "https://botter.test/sign-in",
    emailed: false,
  });
  client.invitations.revoke.mockResolvedValue({ ok: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<PeopleSettings />);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("PeopleSettings", () => {
  it("invites an email into the chosen departments and shows the link when not emailed", async () => {
    const boxes = () =>
      container.querySelectorAll<HTMLInputElement>("input[type=checkbox]:not([role=switch])");
    await act(async () => {
      boxes()[0]!.click();
    });
    await act(async () => {
      boxes()[1]!.click();
    });
    await act(async () => {
      setValue(container.querySelector<HTMLInputElement>("input[type=email]")!, "new@acme.test");
    });
    await act(async () => {
      container.querySelector("form")!.requestSubmit();
    });
    expect(client.invitations.create).toHaveBeenCalledWith({
      email: "new@acme.test",
      departments: [{ departmentId: "dept-1", role: "head" }],
    });
    expect(container.querySelector<HTMLInputElement>("input[readonly]")?.value).toBe(
      "https://botter.test/sign-in",
    );
    expect(container.textContent).toContain("new@acme.test");
  });

  it("switches who may sign in", async () => {
    await act(async () => {
      container.querySelector<HTMLInputElement>("input[role=switch]")!.click();
    });
    expect(client.company.signInMode.set).toHaveBeenCalledWith({ mode: "organisation" });
  });

  it("revokes a pending invitation", async () => {
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>("button[aria-label='Revoke old@acme.test']")!
        .click();
    });
    expect(client.invitations.revoke).toHaveBeenCalledWith({ invitationId: "inv-1" });
    expect(container.textContent).not.toContain("old@acme.test");
  });
});
