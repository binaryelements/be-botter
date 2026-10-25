// @vitest-environment jsdom
import type { SecurityEvent } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({ security: { events: vi.fn() } }));

vi.mock("../lib/rpc", () => ({ rpc: client }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
}));

import { AuditLog } from "./AuditLog";

function event(id: string, type: SecurityEvent["type"]): SecurityEvent {
  return {
    id,
    type,
    userId: `user-${id}`,
    spaceId: null,
    ip: null,
    userAgent: null,
    metadata: {},
    createdAt: "2026-01-02T03:04:05.000Z",
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function rows() {
  return [...container.querySelectorAll('[data-testid="audit-log-row"]')].map(
    (row) => row.textContent,
  );
}

it("lists the newest events and filters by type", async () => {
  client.security.events.mockResolvedValueOnce([
    event("e1", "auth.sign_in"),
    event("e2", "access.changed"),
  ]);
  await act(async () => root.render(<AuditLog isDeploymentOwner />));
  expect(container.querySelector('[data-testid="audit-log"]')).not.toBeNull();
  expect(rows()).toHaveLength(2);
  expect(rows()[0]).toContain("auth.sign_in");
  expect(rows()[0]).toContain("user-e1");

  client.security.events.mockResolvedValueOnce([event("e3", "approval.decided")]);
  const select = container.querySelector<HTMLSelectElement>('[data-testid="audit-log-type"]');
  if (!select) throw new Error("Missing type filter");
  await act(async () => {
    select.value = "approval.decided";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(client.security.events).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "approval.decided" }),
  );
  expect(rows()).toEqual([expect.stringContaining("approval.decided")]);
});

it("loads the next page after the last row and appends it", async () => {
  client.security.events.mockResolvedValueOnce(
    Array.from({ length: 50 }, (_, index) => event(`e${index}`, "auth.sign_in")),
  );
  await act(async () => root.render(<AuditLog isDeploymentOwner />));
  expect(rows()).toHaveLength(50);

  client.security.events.mockResolvedValueOnce([event("e50", "auth.sign_out")]);
  const more = container.querySelector<HTMLButtonElement>('[data-testid="audit-log-more"]');
  if (!more) throw new Error("Missing load more");
  await act(async () => more.click());
  expect(client.security.events).toHaveBeenLastCalledWith(
    expect.objectContaining({ cursor: "e49" }),
  );
  expect(rows()).toHaveLength(51);
  expect(rows()[50]).toContain("auth.sign_out");
  expect(container.querySelector('[data-testid="audit-log-more"]')).toBeNull();
});

it("renders nothing for other users", async () => {
  await act(async () => root.render(<AuditLog isDeploymentOwner={false} />));
  expect(container.querySelector('[data-testid="audit-log"]')).toBeNull();
  expect(client.security.events).not.toHaveBeenCalled();
});
