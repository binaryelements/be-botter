// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("react-router-dom", async (original) => ({
  ...(await original<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (s: TemplateStringsArray) => s[0] }),
}));
vi.mock("../components/integrations/IntegrationSetup", () => ({ IntegrationSetup: () => null }));
vi.mock("../lib/rpc", () => ({
  rpc: {
    bots: { list: async () => [{ id: "b1", name: "Bot" }] },
    integrationSetup: { get: async () => ({ canConfigure: true }) },
    me: async () => ({ companyReady: true, isDeploymentOwner: false }),
  },
}));

import { IntegrationSetupPage } from "./IntegrationSetup";

it("sends company people back to the app", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <MemoryRouter>
        <IntegrationSetupPage />
      </MemoryRouter>,
    ),
  );
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("/app", { replace: true }));
  await act(async () => root.unmount());
});
