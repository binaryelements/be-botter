import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { McpConnector } from "./mcp-connector.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

/** Answers initialize and tools/list, naming each tool after the server's path. */
async function fakeMcp(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : new Request(input, init);
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const message = (await request.json()) as { id?: number; method?: string };
  const name = new URL(request.url).pathname.slice(1);
  if (message.method === "initialize")
    return Response.json({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name, version: "1" },
      },
    });
  if (message.method === "tools/list")
    return Response.json({
      jsonrpc: "2.0",
      id: message.id,
      result: { tools: [{ name, inputSchema: { type: "object" } }] },
    });
  return new Response(null, { status: 202 });
}

describePostgres("company MCP servers (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `mcp-org-${suffix}`;
  const spaceId = `mcp-space-${suffix}`;
  const adminId = `mcp-admin-${suffix}`;
  const staffId = `mcp-staff-${suffix}`;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let botId: string;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    for (const id of [adminId, staffId])
      await system.user.create({
        data: { id, name: id, email: `${id}@rakazo.test`, emailVerified: false },
      });
    await system.organization.create({
      data: { id: organizationId, name: "Mcp Co", slug: organizationId, createdAt: new Date() },
    });
    await system.space.create({
      data: { id: spaceId, organizationId, name: "Mcp Co", isDefault: true },
    });
    botId = (
      await system.bot.create({ data: { spaceId, userId: adminId, name: "Helper", color: "#000" } })
    ).id;
    const departmentA = await system.department.create({ data: { spaceId, name: "A" } });
    const departmentB = await system.department.create({ data: { spaceId, name: "B" } });
    await system.departmentBot.create({ data: { departmentId: departmentA.id, botId } });
    const server = (slug: string, departmentIds: string[]) =>
      system.mcpServer.create({
        data: {
          spaceId,
          userId: adminId,
          slug,
          name: slug,
          transport: "streamable_http",
          endpoint: `https://mcp.example.test/${slug}`,
          shared: true,
          departments: { create: departmentIds.map((departmentId) => ({ departmentId })) },
        },
      });
    await server("only-a", [departmentA.id]);
    await server("everyone", []);
    await server("only-b", [departmentB.id]);
  });

  afterAll(async () => {
    if (!prisma) return;
    await system.organization.deleteMany({ where: { id: organizationId } });
    await system.user.deleteMany({ where: { id: { in: [adminId, staffId] } } });
    await close();
  });

  it("gives a bot the servers shared with its departments or the whole company", async () => {
    const connector = new McpConnector(prisma, {} as never, {
      network: {
        fetch: vi.fn(fakeMcp),
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
      },
    });
    try {
      const tools = await runAsTenant({ spaceId, userId: staffId }, () =>
        connector.discoverTools({
          operationId: "test",
          traceId: "test",
          spaceId,
          userId: staffId,
          botId,
          signal: new AbortController().signal,
        }),
      );
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "mcp__everyone__everyone",
        "mcp__only-a__only-a",
      ]);
    } finally {
      await connector.close();
    }
  });
});
