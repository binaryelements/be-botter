import { expect, it } from "vitest";
import { firstRunRoute, hidesSetup } from "./company-access";

const me = {
  canManageConnections: true,
  companyReady: false,
  companySetupPending: false,
  isDeploymentOwner: false,
};

it("sends a first-run admin to onboarding", () => {
  expect(firstRunRoute(me)).toBe("/onboarding");
  expect(firstRunRoute(undefined)).toBe("/onboarding");
});

it("keeps company people in the app", () => {
  expect(firstRunRoute({ ...me, companyReady: true })).toBeNull();
  expect(hidesSetup({ ...me, companyReady: true })).toBe(true);
});

it("still shows the superadmin everything and sends them to setup while pending", () => {
  const owner = { ...me, isDeploymentOwner: true };
  expect(hidesSetup({ ...owner, companyReady: true })).toBe(false);
  expect(firstRunRoute({ ...owner, companyReady: true })).toBe("/onboarding");
  expect(firstRunRoute({ ...owner, companySetupPending: true })).toBe("/setup");
});

it("respects the admin-only connections switch", () => {
  expect(firstRunRoute({ ...me, canManageConnections: false })).toBeNull();
});
