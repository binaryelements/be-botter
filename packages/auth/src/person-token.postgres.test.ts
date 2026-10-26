import type { SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPersonTokenSource, saveSsoToken } from "./person-token.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("SSO token secrets (PostgreSQL)", () => {
  const userId = `sso-user-${process.pid}-${Date.now()}`;
  // Inline refs, as the encrypted store produces; sealing is the store's concern.
  const secrets = {
    put: async (plaintext: string) => ({ id: `${userId}-s`, ciphertext: `inline:${plaintext}` }),
    load: async (ref: string) => ref.slice("inline:".length),
  } as unknown as Pick<SecretStore, "put" | "load">;
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await asSystem(prisma).user.create({
      data: { id: userId, name: userId, email: `${userId}@rakazo.test`, emailVerified: false },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await asSystem(prisma).user.deleteMany({ where: { id: userId } });
    await close();
  });

  it("stores an account-level token that only its person reads back", async () => {
    const expiresAt = Date.now() + 3_600_000;
    await runAsSystem("test", () =>
      saveSsoToken({ prisma, secrets }, userId, { accessToken: "access", expiresAt }),
    );
    const source = createPersonTokenSource({ prisma, secrets });
    expect(await runAsTenant({ spaceId: "any-space", userId }, () => source(userId))).toEqual({
      accessToken: "access",
      expiresAt,
    });
    expect(
      await runAsTenant({ spaceId: "any-space", userId: "someone-else" }, () => source(userId)),
    ).toBeNull();
  });
});
