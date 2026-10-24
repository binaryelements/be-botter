// @vitest-environment jsdom
import type { ThreadMessage } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../lib/rpc", () => ({ rpc: {} }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { MessageView } from "./message-view";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const message: ThreadMessage = {
  id: "m1",
  threadId: "thread",
  seq: 1,
  role: "user",
  userId: "user-staff",
  createdAt: new Date().toISOString(),
  blocks: [{ kind: "text", text: "Team question" }],
};

function render(speakerName: string | undefined, readOnly = false) {
  const noop = async () => {};
  return act(async () =>
    root.render(
      <MessageView
        artifactTarget={{ botId: "bot" }}
        message={message}
        canAnswer={false}
        canDismiss={false}
        onAnswer={noop}
        onOpenBot={() => {}}
        onOpenPeerMessages={() => {}}
        onTogglePeerReplies={() => {}}
        speakerName={speakerName}
        peerBot={() => undefined}
        onRefresh={noop}
        onBotChanged={noop}
        onAddRoutine={() => {}}
        voiceReady={false}
        speaking={false}
        onSpeak={() => {}}
        onOpenComputer={() => {}}
        showToolActivity={false}
        readOnly={readOnly}
        onReply={() => {}}
        onReact={noop}
      />,
    ),
  );
}

it("shows the sender above a user message from someone else", async () => {
  await render("IT Staff");
  expect(container.querySelector('[data-testid="message-sender"]')?.textContent).toBe("IT Staff");
  expect(container.querySelector('[data-testid="message-user-bubble"]')?.textContent).toBe(
    "Team question",
  );
});

it("shows no sender for the viewer's own messages", async () => {
  await render(undefined);
  expect(container.querySelector('[data-testid="message-sender"]')).toBeNull();
});

it("offers no reply or reaction on a read-only thread", async () => {
  await render("IT Staff", true);
  expect(container.querySelector('[aria-label="Reply"]')).toBeNull();
});
