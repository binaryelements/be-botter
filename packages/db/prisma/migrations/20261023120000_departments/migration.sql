-- Departments: an access layer inside a Space. People and bots each belong to any
-- number of departments; a person may use a bot when they share one with it.
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "departments_spaceId_name_key" ON "departments"("spaceId", "name");
ALTER TABLE "departments" ADD CONSTRAINT "departments_spaceId_fkey"
    FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "department_users" (
    "id" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "department_users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "department_users_departmentId_userId_key" ON "department_users"("departmentId", "userId");
CREATE INDEX "department_users_userId_idx" ON "department_users"("userId");
ALTER TABLE "department_users" ADD CONSTRAINT "department_users_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "department_users" ADD CONSTRAINT "department_users_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "department_bots" (
    "id" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "department_bots_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "department_bots_departmentId_botId_key" ON "department_bots"("departmentId", "botId");
CREATE INDEX "department_bots_botId_idx" ON "department_bots"("botId");
ALTER TABLE "department_bots" ADD CONSTRAINT "department_bots_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "department_bots" ADD CONSTRAINT "department_bots_botId_fkey"
    FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security in the shape of 20261022120000_row_level_security_tenant_tables:
-- departments by Space, the link tables through their department. New tables, so no
-- previous-release policy is needed.
ALTER TABLE "departments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY departments_tenant ON "departments"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY departments_system ON "departments"
  USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "department_users" ENABLE ROW LEVEL SECURITY;
CREATE POLICY department_users_tenant ON "department_users"
  USING (EXISTS (
    SELECT 1 FROM "departments" d
    WHERE d."id" = "department_users"."departmentId"
      AND d."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ));
CREATE POLICY department_users_system ON "department_users"
  USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "department_bots" ENABLE ROW LEVEL SECURITY;
CREATE POLICY department_bots_tenant ON "department_bots"
  USING (EXISTS (
    SELECT 1 FROM "departments" d
    WHERE d."id" = "department_bots"."departmentId"
      AND d."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ));
CREATE POLICY department_bots_system ON "department_bots"
  USING (current_setting('app.rls_bypass', true) = 'on');
