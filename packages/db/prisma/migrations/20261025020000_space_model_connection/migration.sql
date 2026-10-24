-- One model connection per Space, set by its owners, for members' runs that have no model
-- connection of their own. Its key is a secret with spaceId set, which the secrets policy
-- already shares across the Space. New table, so the previous release never reads it.
CREATE TABLE "space_model_connections" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modelId" TEXT,
    "thinkingLevel" TEXT,
    "label" TEXT NOT NULL,
    "supportsImages" BOOLEAN NOT NULL DEFAULT true,
    "secretId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "space_model_connections_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "space_model_connections_spaceId_key" ON "space_model_connections"("spaceId");
CREATE UNIQUE INDEX "space_model_connections_secretId_key" ON "space_model_connections"("secretId");
ALTER TABLE "space_model_connections" ADD CONSTRAINT "space_model_connections_spaceId_fkey"
    FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "space_model_connections" ADD CONSTRAINT "space_model_connections_secretId_fkey"
    FOREIGN KEY ("secretId") REFERENCES "secrets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "space_model_connections" ENABLE ROW LEVEL SECURITY;
CREATE POLICY space_model_connections_tenant ON "space_model_connections"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY space_model_connections_system ON "space_model_connections"
  USING (current_setting('app.rls_bypass', true) = 'on');
