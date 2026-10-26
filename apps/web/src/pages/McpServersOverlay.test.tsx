// @vitest-environment jsdom
import type { McpServer } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ConnectionsAccess } from "../lib/connections-access";
import { McpServersOverlay } from "./McpServersOverlay";

const mocks = vi.hoisted(() => ({ list: vi.fn(), test: vi.fn(), create: vi.fn() }));
vi.mock("../lib/rpc", () => ({
  rpc: {
    mcp: { servers: mocks, assignments: { all: async () => [] } },
    bots: { list: async () => [] },
    departments: { list: async () => [{ id: "sales", name: "Sales" }] },
  },
}));
vi.mock("../lib/mcp-connect", () => ({
  MCP_OAUTH_CHANNEL: "test",
  mcpOAuthRedirectUri: () => "",
  connectMcpOauth: vi.fn(),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + (i ? String(values[i - 1]) : "") + part, ""),
  }),
}));
vi.mock("@rakazo/ui-web", async () => {
  const { createElement } = await import("react");
  const container = ({ children }: { children: ReactNode }) => createElement("div", null, children);
  return Object.fromEntries([
    ...[
      "Badge",
      "Card",
      "CardContent",
      "CardHeader",
      "CardTitle",
      "Dialog",
      "DialogClose",
      "DialogContent",
      "DialogHeader",
      "DialogTitle",
      "Field",
      "FieldError",
      "FieldGroup",
      "FieldLabel",
      "FieldTitle",
      "TabsList",
      "Toggle",
    ].map((name) => [name, container]),
    [
      "Button",
      ({
        children,
        onClick,
        disabled,
      }: {
        children: ReactNode;
        onClick: () => void;
        disabled: boolean;
      }) => createElement("button", { onClick, disabled }, children),
    ],
    [
      "Input",
      ({ id, value, onChange }: { id?: string; value?: string; onChange?: () => void }) =>
        createElement("input", { id, value, onChange }),
    ],
    [
      "Switch",
      ({
        id,
        checked,
        onCheckedChange,
      }: {
        id: string;
        checked: boolean;
        onCheckedChange: (on: boolean) => void;
      }) =>
        createElement("input", {
          id,
          type: "checkbox",
          checked,
          onChange: (event: { target: { checked: boolean } }) =>
            onCheckedChange(event.target.checked),
        }),
    ],
    [
      "TabsTrigger",
      ({ children, value }: { children: ReactNode; value: string }) =>
        createElement("button", { "data-tab": value }, children),
    ],
    ["Textarea", () => null],
    [
      "Tabs",
      ({
        children,
        onValueChange,
      }: {
        children: ReactNode;
        onValueChange: (value: string) => void;
      }) =>
        createElement(
          "div",
          {
            onClick: (event: { target: { dataset?: { tab?: string } } }) => {
              const tab = event.target.dataset?.tab;
              if (tab) onValueChange(tab);
            },
          },
          children,
        ),
    ],
    ["toast", { success: vi.fn(), error: vi.fn() }],
  ]);
});

it("keeps each concurrent connection test busy until its own request finishes", async () => {
  const servers = ["one", "two"].map(
    (id) =>
      ({
        id,
        name: id,
        transport: "stdio",
        oauthStatus: "none",
        health: { status: "unknown" },
        enabled: true,
      }) as McpServer,
  );
  mocks.list.mockResolvedValue(servers);
  const finish = new Map<string, (server: McpServer) => void>();
  mocks.test.mockImplementation(
    ({ id }: { id: string }) => new Promise((resolve) => finish.set(id, resolve)),
  );
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<McpServersOverlay onClose={() => {}} />));
    const buttons = Array.from(host.querySelectorAll("button")).filter((button) =>
      button.textContent?.includes("Test connection"),
    );
    expect(buttons).toHaveLength(2);
    await act(async () => {
      buttons[0]?.click();
      buttons[1]?.click();
    });
    expect(buttons.every((button) => button.disabled)).toBe(true);
    await act(async () => finish.get("two")?.(servers[1] as McpServer));
    expect(buttons[0]?.disabled).toBe(true);
    expect(buttons[1]?.disabled).toBe(false);
    await act(async () => finish.get("one")?.(servers[0] as McpServer));
    expect(buttons.every((button) => !button.disabled)).toBe(true);
  } finally {
    await act(async () => root.unmount());
  }
});

it.each([
  [403, 2],
  [404, 2],
  [503, 5],
])("after a %i install poll, list requests total %i", async (status, requests) => {
  vi.useFakeTimers();
  const installing = {
    id: "one",
    name: "one",
    transport: "stdio",
    oauthStatus: "none",
    health: { status: "installing" },
    enabled: true,
  } as McpServer;
  mocks.list
    .mockReset()
    .mockResolvedValueOnce([installing])
    .mockRejectedValueOnce(Object.assign(new Error("Refused"), { status }))
    .mockResolvedValue([installing]);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<McpServersOverlay onClose={() => {}} />));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(mocks.list).toHaveBeenCalledTimes(requests);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});

async function type(host: HTMLElement, selector: string, value: string) {
  const input = host.querySelector(selector) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function buttonByText(host: HTMLElement, text: string) {
  return Array.from(host.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(text),
  );
}

it("shares a server with the company, signed in as each person, for one department", async () => {
  mocks.list.mockReset().mockResolvedValue([]);
  mocks.create.mockReset().mockResolvedValue({ id: "new" });
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<McpServersOverlay canShare onClose={() => {}} />));
    expect(host.textContent).not.toContain("Sign in as");
    expect(host.textContent).toContain("OAuth client ID");
    await type(host, "#mcp-name", "Graph");
    await type(host, "#mcp-endpoint", "https://mcp.example.test/mcp");
    await act(async () => (host.querySelector("#mcp-shared") as HTMLInputElement).click());
    expect(host.textContent).toContain("Sign in as");
    expect(host.textContent).not.toContain("OAuth client ID");
    await act(async () => buttonByText(host, "Each person")?.click());
    // Each person signs in with their own token: no static credentials to add.
    expect(host.textContent).not.toContain("Advanced");
    await act(async () => buttonByText(host, "Sales")?.click());
    await act(async () => buttonByText(host, "Add server")?.click());
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Graph",
        shared: true,
        signIn: "person",
        departmentIds: ["sales"],
        oauthClient: undefined,
      }),
    );
  } finally {
    await act(async () => root.unmount());
  }
});

it("offers no sharing outside the company space", async () => {
  mocks.list.mockReset().mockResolvedValue([]);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<McpServersOverlay onClose={() => {}} />));
    expect(host.querySelector("#mcp-shared")).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it("hides adding and connecting while only admins add connections", async () => {
  mocks.list.mockReset().mockResolvedValue([
    {
      id: "one",
      name: "one",
      transport: "streamable_http",
      oauthStatus: "none",
      health: { status: "unknown" },
      enabled: true,
    } as McpServer,
  ]);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <ConnectionsAccess value={false}>
          <McpServersOverlay onClose={() => {}} />
        </ConnectionsAccess>,
      ),
    );
    expect(host.textContent).toContain("Test connection");
    expect(buttonByText(host, "Add server")).toBeUndefined();
    expect(buttonByText(host, "Connect OAuth")).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
  }
});
