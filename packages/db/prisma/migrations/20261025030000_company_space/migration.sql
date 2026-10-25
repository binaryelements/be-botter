-- The Space that staff signing in through SSO join as members. Defaults to the deployment
-- owner's default Space, which is the company's on a company deployment; the owner can
-- point it elsewhere. Additive: the previous release never reads it.
ALTER TABLE "deployment_settings" ADD COLUMN "companySpaceId" TEXT;
UPDATE "deployment_settings" d
SET "companySpaceId" = (
  SELECT s."id" FROM "spaces" s
  JOIN "space_members" m ON m."spaceId" = s."id"
  WHERE m."userId" = d."ownerUserId" AND s."isDefault"
  ORDER BY s."createdAt" ASC
  LIMIT 1
)
WHERE d."ownerUserId" IS NOT NULL AND d."companySpaceId" IS NULL;
