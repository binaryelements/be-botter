import { expect, it } from "vitest";
import { emptySpaceRoute, firstRunRoute, hidesSetup, rootRoute } from "./company-access";

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

it("sends the superadmin to the wizard until the site is ready, whatever the Space", () => {
  expect(rootRoute({ superadmin: true, siteReady: false })).toBe("/setup");
  expect(rootRoute({ superadmin: true, siteReady: true })).toBe("/app");
  expect(rootRoute({ superadmin: false, siteReady: false })).toBe("/app");
});

it("never sends the superadmin to onboarding", () => {
  const superadmin = { ...me, isDeploymentOwner: true, superadmin: true };
  expect(firstRunRoute({ ...superadmin, siteReady: false })).toBe("/setup");
  expect(firstRunRoute({ ...superadmin, siteReady: true })).toBeNull();
});

it("opens an empty Space in the app for the superadmin and in onboarding for a first-run admin", () => {
  expect(
    emptySpaceRoute({ ...me, isDeploymentOwner: true, superadmin: true, siteReady: true }),
  ).toBe("/app");
  expect(emptySpaceRoute(me)).toBe("/onboarding");
});
