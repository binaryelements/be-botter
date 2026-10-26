-- Company connections: an MCP server can be shared with the company Space, signed in with one
-- shared token or each person's own, and limited to departments. Admins can restrict who adds
-- connections. All additive with defaults: the previous release never reads them.
ALTER TABLE "mcp_servers" ADD COLUMN "shared" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "mcp_servers" ADD COLUMN "signIn" TEXT NOT NULL DEFAULT 'server';
ALTER TABLE "deployment_settings" ADD COLUMN "connectionsAdminOnly" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "mcp_server_departments" (
    "serverId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,

    CONSTRAINT "mcp_server_departments_pkey" PRIMARY KEY ("serverId", "departmentId")
);
CREATE INDEX "mcp_server_departments_departmentId_idx" ON "mcp_server_departments"("departmentId");
ALTER TABLE "mcp_server_departments" ADD CONSTRAINT "mcp_server_departments_serverId_fkey"
    FOREIGN KEY ("serverId") REFERENCES "mcp_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mcp_server_departments" ADD CONSTRAINT "mcp_server_departments_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security like department_bots: through the department's Space. New table, so no
-- previous-release policy is needed.
ALTER TABLE "mcp_server_departments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY mcp_server_departments_tenant ON "mcp_server_departments"
  USING (EXISTS (
    SELECT 1 FROM "departments" d
    WHERE d."id" = "mcp_server_departments"."departmentId"
      AND d."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ));
CREATE POLICY mcp_server_departments_system ON "mcp_server_departments"
  USING (current_setting('app.rls_bypass', true) = 'on');
