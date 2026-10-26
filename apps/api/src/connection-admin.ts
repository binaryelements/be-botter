import { ORPCError } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import {
  isSpaceOwner,
  mayManageConnections as mayManageConnectionsIn,
  readConnectionsSwitch,
} from "@rakazo/db";
import type { RouterDeps } from "./router.js";

type Deps = Pick<RouterDeps, "prisma">;

const readSwitch = (deps: Deps) => readConnectionsSwitch(deps.prisma);

export function mayManageConnections(actor: Actor, deps: Deps): Promise<boolean> {
  return mayManageConnectionsIn(deps.prisma, actor);
}

export async function assertMayManageConnections(actor: Actor, deps: Deps): Promise<void> {
  if (!(await mayManageConnections(actor, deps))) throw new ORPCError("FORBIDDEN");
}

/** While the switch is on, only the deployment owner creates spaces. */
export async function assertMayCreateSpace(actor: Actor, deps: Deps): Promise<void> {
  if (actor.isDeploymentOwner) return;
  if ((await readSwitch(deps))?.connectionsAdminOnly) throw new ORPCError("FORBIDDEN");
}

/** The company space the deployment's admins share connections in, or null. */
export async function companySpaceIdOf(deps: Deps): Promise<string | null> {
  return (await readSwitch(deps))?.companySpaceId ?? null;
}

/** Owners share connections with the company, from the company space only. */
export async function mayShareConnections(actor: Actor, deps: Deps): Promise<boolean> {
  return isSpaceOwner(actor) && (await companySpaceIdOf(deps)) === actor.spaceId;
}

export type CompanyServerFields = {
  shared: boolean;
  signIn: "server" | "person";
  departmentIds: string[];
};

/**
 * The company fields an MCP server create or update ends up with. Only owners share, and only
 * in the company space; a shared server signs in with a static credential or each person's
 * SSO token (remote only, with no stored credential), never its own OAuth, and is limited to this space's departments.
 * Omitted fields keep the existing shared server's values.
 */
export async function resolveCompanyServer(
  deps: Deps,
  actor: Actor,
  input: Partial<CompanyServerFields> & {
    transport: string;
    secret?: string;
    headers?: Record<string, string>;
  },
  existing: CompanyServerFields | null,
  hasOAuthClient: boolean,
): Promise<CompanyServerFields> {
  const shared = input.shared ?? existing?.shared ?? false;
  const kept = shared ? existing : null;
  const signIn = input.signIn ?? kept?.signIn ?? "server";
  const departmentIds = [...new Set(input.departmentIds ?? kept?.departmentIds ?? [])];
  if (!shared) {
    if (signIn !== "server" || departmentIds.length > 0) throw new ORPCError("BAD_REQUEST");
    return { shared, signIn, departmentIds };
  }
  if (!(await mayShareConnections(actor, deps))) throw new ORPCError("FORBIDDEN");
  if ((signIn === "person" && input.transport === "stdio") || hasOAuthClient) {
    throw new ORPCError("BAD_REQUEST");
  }
  // Each person signs in with their own token; a stored admin credential would ride along.
  if (signIn === "person" && (input.secret || Object.keys(input.headers ?? {}).length > 0)) {
    throw new ORPCError("BAD_REQUEST");
  }
  if (departmentIds.length > 0) {
    const found = await deps.prisma.department.count({
      where: { id: { in: departmentIds }, spaceId: actor.spaceId },
    });
    if (found !== departmentIds.length) throw new ORPCError("BAD_REQUEST");
  }
  return { shared, signIn, departmentIds };
}
