// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({ deployment: { get: vi.fn(), update: vi.fn() } }));
const toast = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock("../lib/rpc", () => ({ rpc: client }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  toast,
  Label: ({ children, htmlFor }: ComponentProps<"label">) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: Omit<ComponentProps<"input">, "onChange"> & { onCheckedChange: (on: boolean) => void }) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
      {...props}
    />
  ),
}));

import { ConnectionsAdminOnlySetting } from "./ConnectionsAdminOnlySetting";

it("reads the deployment switch and saves a change", async () => {
  client.deployment.get.mockResolvedValue({ connectionsAdminOnly: false });
  client.deployment.update.mockResolvedValue({ connectionsAdminOnly: true });
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<ConnectionsAdminOnlySetting />));
  const input = host.querySelector("input") as HTMLInputElement;
  expect(host.textContent).toContain("Only admins add bots and connections");
  expect(input.checked).toBe(false);
  await act(async () => input.click());
  expect(client.deployment.update).toHaveBeenCalledWith({ connectionsAdminOnly: true });
  expect(input.checked).toBe(true);
  await act(async () => root.unmount());
});

it("says why the switch could not be read or saved", async () => {
  client.deployment.get.mockRejectedValueOnce(new Error("Not allowed"));
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<ConnectionsAdminOnlySetting />));
  expect(toast.error).toHaveBeenCalledWith("Not allowed");
  await act(async () => root.unmount());

  toast.error.mockClear();
  client.deployment.get.mockResolvedValue({ connectionsAdminOnly: false });
  client.deployment.update.mockRejectedValueOnce(new Error("Could not save the switch"));
  const again = createRoot(host);
  await act(async () => again.render(<ConnectionsAdminOnlySetting />));
  const input = host.querySelector("input") as HTMLInputElement;
  await act(async () => input.click());
  expect(toast.error).toHaveBeenCalledWith("Could not save the switch");
  expect(input.checked).toBe(false);
  await act(async () => again.unmount());
});
