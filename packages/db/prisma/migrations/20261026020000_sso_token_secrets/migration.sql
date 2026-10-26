-- A person's SSO token is an account-level secret like their model and voice keys. Widening
-- the check is safe for the previous release: it never writes kind 'sso-token'.
ALTER TABLE "secrets" DROP CONSTRAINT "secrets_scope_check";
ALTER TABLE "secrets"
  ADD CONSTRAINT "secrets_scope_check"
  CHECK (
    ("kind" IN ('model', 'voice', 'sso-token') AND "spaceId" IS NULL)
    OR ("kind" NOT IN ('model', 'voice', 'sso-token') AND "spaceId" IS NOT NULL)
  ) NOT VALID;
ALTER TABLE "secrets" VALIDATE CONSTRAINT "secrets_scope_check";
