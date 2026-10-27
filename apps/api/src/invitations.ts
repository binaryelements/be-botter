import { ORPCError } from "@orpc/server";
import type { Actor, Invitation } from "@rakazo/contracts";
import { readCompanySetup, runAsSystem, updateCompanySetup } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { audit, inCompany, read } from "./company-setup.js";
import type { RouterDeps } from "./router.js";

type Deps = Pick<RouterDeps, "prisma" | "email" | "env">;
type Departments = Invitation["departments"];

/** The superadmin, or an owner acting inside the company Space; owning another Space is not enough. */
async function requireCompanyOwner(deps: Deps, actor: Actor): Promise<void> {
  if (actor.isDeploymentOwner) return;
  const { companySpaceId } = await read(deps);
  if (!companySpaceId || actor.spaceId !== companySpaceId || actor.spaceRole !== "owner") {
    throw new ORPCError("FORBIDDEN");
  }
}

const toInvitation = (row: {
  id: string;
  email: string;
  departments: unknown;
  acceptedAt: Date | null;
}): Invitation => ({
  id: row.id,
  email: row.email,
  departments: row.departments as Departments,
  acceptedAt: row.acceptedAt?.toISOString() ?? null,
});

export async function getSignInMode(deps: Deps, actor: Actor) {
  await requireCompanyOwner(deps, actor);
  const setup = await read(deps);
  const departments = setup.companySpaceId
    ? await inCompany(deps, actor, (_scoped, company) =>
        deps.prisma.department.findMany({
          where: { spaceId: company.companySpaceId },
          orderBy: { createdAt: "asc" },
          select: { id: true, name: true },
        }),
      )
    : [];
  return { mode: setup.signInMode, ready: Boolean(setup.readyAt), departments };
}

export async function setSignInMode(deps: Deps, actor: Actor, mode: "invited" | "organisation") {
  await requireCompanyOwner(deps, actor);
  await runAsSystem("set the sign-in mode", () =>
    updateCompanySetup(deps.prisma, { signInMode: mode }),
  );
  await audit(actor, "signInMode", { signInMode: mode });
  return {
    mode: (await runAsSystem("read company setup", () => readCompanySetup(deps.prisma))).signInMode,
  };
}

export async function listInvitations(deps: Deps, actor: Actor): Promise<Invitation[]> {
  await requireCompanyOwner(deps, actor);
  const rows = await inCompany(deps, actor, (_scoped, company) =>
    deps.prisma.spaceInvitation.findMany({
      where: { spaceId: company.companySpaceId },
      orderBy: { createdAt: "asc" },
    }),
  );
  return rows.map(toInvitation);
}

export async function createInvitation(
  deps: Deps,
  actor: Actor,
  input: { email: string; departments: Departments },
) {
  await requireCompanyOwner(deps, actor);
  const email = input.email.toLowerCase();
  const { invitation, companyName } = await inCompany(deps, actor, async (_scoped, company) => {
    const ids = [...new Set(input.departments.map((link) => link.departmentId))];
    const known = await deps.prisma.department.count({
      where: { spaceId: company.companySpaceId, id: { in: ids } },
    });
    if (ids.length !== input.departments.length || known !== ids.length) {
      throw new ORPCError("BAD_REQUEST", { message: "Choose departments of the company." });
    }
    const existing = await deps.prisma.spaceInvitation.findUnique({
      where: { spaceId_email: { spaceId: company.companySpaceId, email } },
      select: { id: true },
    });
    if (existing) throw new ORPCError("CONFLICT", { message: "That person is already invited." });
    const row = await deps.prisma.spaceInvitation.create({
      data: {
        spaceId: company.companySpaceId,
        email,
        departments: input.departments,
        createdByUserId: actor.userId,
      },
    });
    return { invitation: toInvitation(row), companyName: company.companyName ?? "" };
  });
  const signInUrl = new URL("/sign-in", deps.env.webOrigin).href;
  let emailed = false;
  if (deps.email) {
    try {
      await deps.email.send({
        to: email,
        subject: `You're invited to ${companyName} on BE Botter`,
        text: `You've been invited to ${companyName} on BE Botter. Sign in here to get started: ${signInUrl}`,
      });
      emailed = true;
    } catch (error) {
      getLogger().error("invitation email failed", error);
    }
  }
  await audit(actor, "invite");
  return { invitation, signInUrl, emailed };
}

export async function revokeInvitation(deps: Deps, actor: Actor, invitationId: string) {
  await requireCompanyOwner(deps, actor);
  const { count } = await inCompany(deps, actor, (_scoped, company) =>
    deps.prisma.spaceInvitation.deleteMany({
      where: { id: invitationId, spaceId: company.companySpaceId, acceptedAt: null },
    }),
  );
  if (count === 0) throw new ORPCError("NOT_FOUND");
  await audit(actor, "revokeInvitation");
  return { ok: true as const };
}
