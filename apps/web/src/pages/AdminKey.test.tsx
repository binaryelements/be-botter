// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ $fetch: vi.fn() }));
vi.mock("../lib/auth", () => ({ authClient: auth }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, i) => `${text}${i > 0 ? String(values[i - 1]) : ""}${part}`, "");
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children?: ReactNode }) => children,
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { AdminKeyPage } from "./AdminKey";

async function render() {
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(<AdminKeyPage />);
  });
  return container;
}

async function submit(container: HTMLElement, key: string) {
  const input = container.querySelector<HTMLInputElement>('[aria-label="Admin key"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, key);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>("button[type=submit]")?.click();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

it("keeps Continue off until a key is typed and hides the key", async () => {
  const container = await render();
  expect(container.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled).toBe(true);
  expect(container.querySelector("input")?.type).toBe("password");
});

it("submits the key and shows the refusal", async () => {
  auth.$fetch.mockResolvedValue({ error: { code: "WRONG_ADMIN_KEY" } });
  const container = await render();
  await submit(container, "f".repeat(64));
  expect(auth.$fetch).toHaveBeenCalledWith(
    "/sign-in/admin-key",
    expect.objectContaining({ method: "POST", body: { key: "f".repeat(64) } }),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Wrong admin key");
});

it("shows an error and frees the button when the request throws", async () => {
  auth.$fetch.mockRejectedValue(new TypeError("Failed to fetch"));
  const container = await render();
  await submit(container, "f".repeat(64));
  expect(container.querySelector('[role="alert"]')?.textContent).not.toBe("");
  expect(container.querySelector('[role="alert"]')?.textContent).not.toBe("Wrong admin key");
  expect(container.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled).toBe(false);
});
