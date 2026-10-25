-- Whether a space asks a person before every connector write ("ask") or only when a rule says
-- so ("rules", today's behaviour). Additive with a default: the previous release never reads it.
ALTER TABLE "spaces" ADD COLUMN "writeApproval" TEXT NOT NULL DEFAULT 'rules';
