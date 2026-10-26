// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({ deployment: { get: vi.fn(), update: vi.fn() } }));

vi.mock("../lib/rpc", () => ({ rpc: client }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
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
  expect(host.textContent).toContain("Only admins add connections");
  expect(input.checked).toBe(false);
  await act(async () => input.click());
  expect(client.deployment.update).toHaveBeenCalledWith({ connectionsAdminOnly: true });
  expect(input.checked).toBe(true);
  await act(async () => root.unmount());
});
