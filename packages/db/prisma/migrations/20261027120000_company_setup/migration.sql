-- Company setup wizard state, invitations and head-run routines. Additive only.
ALTER TABLE "deployment_settings" ADD COLUMN "companyOwnerEmail" TEXT,
    ADD COLUMN "companyReadyAt" TIMESTAMP(3),
    ADD COLUMN "signInMode" TEXT NOT NULL DEFAULT 'invited',
    ADD COLUMN "companyTenantId" TEXT;

ALTER TABLE "routines" ADD COLUMN "runsAsDepartmentHead" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "invitations" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "departments" JSONB NOT NULL DEFAULT '[]',
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "acceptedUserId" TEXT,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "invitations_spaceId_email_key" ON "invitations"("spaceId", "email");
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_spaceId_fkey"
    FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY invitations_tenant ON "invitations"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY invitations_system ON "invitations"
  USING (current_setting('app.rls_bypass', true) = 'on');
