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
  let seq = 0;
  const deleted: string[] = [];
  const secrets = {
    put: async (plaintext: string) => ({
      id: `${userId}-s${++seq}`,
      ciphertext: `inline:${plaintext}`,
    }),
    load: async (ref: string) => ref.slice("inline:".length),
    delete: async (ref: string) => {
      deleted.push(ref);
    },
  } as unknown as Pick<SecretStore, "put" | "load" | "delete">;
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

  it("keeps a token when two saves interleave, and deletes the replaced values", async () => {
    // Both saves insert their row before either removes the rows it replaces.
    let release!: () => void;
    const bothCreated = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pending = 2;
    const racing = {
      secret: {
        create: async (args: Parameters<PrismaClient["secret"]["create"]>[0]) => {
          const row = await prisma.secret.create(args);
          if (--pending === 0) release();
          await bothCreated;
          return row;
        },
        findMany: prisma.secret.findMany.bind(prisma.secret),
        deleteMany: prisma.secret.deleteMany.bind(prisma.secret),
      },
    } as unknown as Pick<PrismaClient, "secret">;
    const expiresAt = Date.now() + 3_600_000;
    deleted.length = 0;
    await runAsSystem("test", () =>
      Promise.all([
        saveSsoToken({ prisma: racing, secrets }, userId, { accessToken: "a", expiresAt }),
        saveSsoToken({ prisma: racing, secrets }, userId, { accessToken: "b", expiresAt }),
      ]),
    );
    const rows = await asSystem(prisma).secret.findMany({
      where: { userId, kind: "sso-token" },
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(deleted.some((ref) => ref.includes('"accessToken":"access"'))).toBe(true);
    const source = createPersonTokenSource({ prisma, secrets });
    expect(
      await runAsTenant({ spaceId: "any-space", userId }, () => source(userId)),
    ).not.toBeNull();
  });
});
