import { ORPCError } from "@orpc/server";
import { buildModelConnectPlaintext, defaultCatalogModelId } from "@rakazo/adapters";
import type { Actor, CompanyModelConnection, ModelConnectInput } from "@rakazo/contracts";
import { usableModelId } from "@rakazo/contracts";
import { isSpaceOwner } from "@rakazo/db";
import type { RouterDeps } from "./router.js";

type CompanyModelDeps = Pick<RouterDeps, "prisma" | "secrets" | "env">;

type Row = {
  provider: string;
  modelId: string | null;
  thinkingLevel: string | null;
  label: string;
  supportsImages: boolean;
};

function toConnection(row: Row, actor: Actor): CompanyModelConnection {
  return {
    provider: row.provider,
    modelId: row.modelId,
    thinkingLevel: row.thinkingLevel as CompanyModelConnection["thinkingLevel"],
    label: row.label,
    supportsImages: row.supportsImages,
    canManage: isSpaceOwner(actor),
  };
}

/** The company's model connection as every member sees it, or null when the space has none. */
export async function getCompanyModelConnection(
  deps: Pick<RouterDeps, "prisma">,
  actor: Actor,
): Promise<CompanyModelConnection | null> {
  const row = await deps.prisma.spaceModelConnection.findUnique({
    where: { spaceId: actor.spaceId },
  });
  return row ? toConnection(row, actor) : null;
}

/**
 * Owners connect an API-key provider for the company. The key is a secret with spaceId set,
 * which the space shares; a previous key is removed once the row points at the new one.
 */
export async function setCompanyModelConnection(
  deps: CompanyModelDeps,
  actor: Actor,
  input: ModelConnectInput,
  signal?: AbortSignal,
): Promise<CompanyModelConnection> {
  if (!isSpaceOwner(actor)) throw new ORPCError("FORBIDDEN");
  if (!input.apiKey) {
    throw new ORPCError("BAD_REQUEST", { message: "The company connection needs an API key" });
  }
  let plaintext: string;
  try {
    plaintext = buildModelConnectPlaintext(input, undefined, {
      allowPrivateEndpoint: actor.isDeploymentOwner || deps.env.mcpAllowPrivateEndpoint === true,
    });
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "Invalid model connection",
    });
  }
  const modelId = usableModelId(input.modelId) ?? defaultCatalogModelId(input.provider, plaintext);
  const stored = await deps.secrets.put(plaintext, {
    operationId: "company-model",
    traceId: "company-model",
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: signal ?? new AbortController().signal,
  });
  const row = await deps.prisma.$transaction(async (tx) => {
    const previous = await tx.spaceModelConnection.findUnique({
      where: { spaceId: actor.spaceId },
      select: { secretId: true },
    });
    await tx.secret.create({
      data: {
        id: stored.id,
        userId: actor.userId,
        spaceId: actor.spaceId,
        // Kind "model" is reserved for a person's own key; the secrets scope check keeps it so.
        kind: "company-model",
        ciphertext: stored.ciphertext,
      },
    });
    const data = {
      provider: input.provider,
      modelId: modelId ?? null,
      thinkingLevel: input.thinkingLevel ?? null,
      label: input.label ?? input.provider,
      supportsImages: input.supportsImages ?? true,
      secretId: stored.id,
      createdByUserId: actor.userId,
    };
    const saved = await tx.spaceModelConnection.upsert({
      where: { spaceId: actor.spaceId },
      create: { spaceId: actor.spaceId, ...data },
      update: data,
    });
    if (previous) await tx.secret.delete({ where: { id: previous.secretId } });
    return saved;
  });
  return toConnection(row, actor);
}

/** Owners remove the company's connection; deleting its secret removes the row with it. */
export async function clearCompanyModelConnection(
  deps: Pick<RouterDeps, "prisma">,
  actor: Actor,
): Promise<void> {
  if (!isSpaceOwner(actor)) throw new ORPCError("FORBIDDEN");
  const row = await deps.prisma.spaceModelConnection.findUnique({
    where: { spaceId: actor.spaceId },
    select: { secretId: true },
  });
  if (row) await deps.prisma.secret.delete({ where: { id: row.secretId } });
}
