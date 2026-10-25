// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  approvalRules: {
    list: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
    policy: vi.fn(),
    setPolicy: vi.fn(),
  },
  autoReview: { get: vi.fn(), set: vi.fn() },
}));

vi.mock("../lib/space-rpc", () => ({ useSpaceRpc: () => client }));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, ""),
}));
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
  Label: ({ htmlFor, children, ...props }: ComponentProps<"label">) => (
    <label htmlFor={htmlFor} {...props}>
      {children}
    </label>
  ),
  Switch: ({
    checked,
    onCheckedChange: _onCheckedChange,
    ...props
  }: ComponentProps<"input"> & { onCheckedChange?: (checked: boolean) => void }) => (
    <input type="checkbox" checked={checked} readOnly {...props} />
  ),
  OptionSelect: ({
    value,
    options,
    onValueChange,
    "data-testid": testId,
    id,
  }: {
    id?: string;
    value: string;
    options: readonly { value: string; label: string }[];
    onValueChange: (value: string) => void;
    "data-testid"?: string;
    className?: string;
    disabled?: boolean;
  }) => (
    <select
      id={id}
      data-testid={testId}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

import { ApprovalRulesSettings } from "./ApprovalRulesSettings";

let container: HTMLDivElement;
let root: Root;

async function render(policy: { writeApproval: "ask" | "rules"; canManage: boolean }) {
  client.approvalRules.list.mockResolvedValue([]);
  client.autoReview.get.mockResolvedValue({ enabled: false, checkerAvailable: false });
  client.approvalRules.policy.mockResolvedValue(policy);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ApprovalRulesSettings />);
  });
  await act(async () => {});
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("ApprovalRulesSettings", () => {
  it("lets a space owner choose to ask before every write", async () => {
    await render({ writeApproval: "rules", canManage: true });
    const select = container.querySelector<HTMLSelectElement>('[data-testid="approval-policy"]');
    if (!select) throw new Error("Missing approval policy select");
    expect(container.textContent).toContain("Approvals");
    expect(select.value).toBe("rules");
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Ask before writes",
      "Only when a rule says so",
    ]);
    client.approvalRules.setPolicy.mockResolvedValue({ writeApproval: "ask", canManage: true });
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(
        select,
        "ask",
      );
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(client.approvalRules.setPolicy).toHaveBeenCalledWith({ writeApproval: "ask" });
    expect(select.value).toBe("ask");
  });

  it("shows members nothing about the space policy", async () => {
    await render({ writeApproval: "ask", canManage: false });
    expect(container.querySelector('[data-testid="approval-policy"]')).toBeNull();
    expect(container.textContent).not.toContain("Approvals");
  });
});
