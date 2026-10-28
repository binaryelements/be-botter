// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ConnectionsAccess } from "../../lib/connections-access";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

import { BotCreatePicker } from "./bot-picker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};

function render(canManage: boolean, canCreate = true) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <ConnectionsAccess value={canManage}>
        <BotCreatePicker
          bots={[]}
          canCreate={canCreate}
          onCreateBot={vi.fn()}
          onOpenBot={vi.fn()}
          onCreateGroup={vi.fn()}
          onCreateSpace={vi.fn()}
          onShowGroupInfo={vi.fn()}
          onShowSpaceInfo={vi.fn()}
        />
      </ConnectionsAccess>,
    );
  });
  const found = container.querySelector('[data-testid="create-new-bot"]') !== null;
  act(() => root.unmount());
  container.remove();
  return found;
}

it("offers a new bot only to people who may add one", () => {
  expect(render(true)).toBe(true);
  expect(render(false)).toBe(false);
});

it("offers the superadmin no new bot even though it may manage connections", () => {
  expect(render(true, false)).toBe(false);
});
