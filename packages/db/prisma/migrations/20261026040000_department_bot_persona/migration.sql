-- The persona template a space's new department bots start from. Additive and nullable: the
-- previous release never reads it, and null means the built-in starter.
ALTER TABLE "spaces" ADD COLUMN "departmentBotInstructions" TEXT;
