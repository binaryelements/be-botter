import type { Me } from "@rakazo/contracts";

type Access = Partial<
  Pick<Me, "canManageConnections" | "companyReady" | "companySetupPending" | "isDeploymentOwner">
>;

/** Company people on a ready company site never see model, connector, plugin or MCP setup. */
export const hidesSetup = (me: Access | null | undefined) =>
  me?.companyReady === true && me.isDeploymentOwner !== true;

/** Where a person with nothing yet goes first, or null to stay in the app. */
export function firstRunRoute(me: Access | null | undefined): "/onboarding" | "/setup" | null {
  if (me?.canManageConnections === false || hidesSetup(me)) return null;
  return me?.companySetupPending ? "/setup" : "/onboarding";
}
