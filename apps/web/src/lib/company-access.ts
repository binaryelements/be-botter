import type { Me } from "@rakazo/contracts";

type Access = Partial<
  Pick<
    Me,
    | "canManageConnections"
    | "companyReady"
    | "companySetupPending"
    | "isDeploymentOwner"
    | "superadmin"
    | "siteReady"
  >
>;

/** Company people on a ready company site never see model, connector, plugin or MCP setup. */
export const hidesSetup = (me: Access | null | undefined) =>
  me?.companyReady === true && me.isDeploymentOwner !== true;

/** Where a person with nothing yet goes first, or null to stay in the app. */
export function firstRunRoute(me: Access | null | undefined): "/onboarding" | "/setup" | null {
  // The superadmin never sees onboarding, whichever Space is active.
  if (me?.superadmin) return me.siteReady ? null : "/setup";
  if (me?.canManageConnections === false || hidesSetup(me)) return null;
  return me?.companySetupPending ? "/setup" : "/onboarding";
}

/** Where opening a Space with nothing in it goes. */
export const emptySpaceRoute = (me: Access | null | undefined) => firstRunRoute(me) ?? "/app";

/** The superadmin lands in the wizard until the company is ready. */
export const rootRoute = (me: Pick<Me, "superadmin" | "siteReady">): "/setup" | "/app" =>
  me.superadmin && !me.siteReady ? "/setup" : "/app";
