-- Whether a head routine is off only because no head can run it yet. Additive with a safe default:
-- the previous release never reads it, and existing routines count as not waiting.
ALTER TABLE "routines" ADD COLUMN "waitingForHead" BOOLEAN NOT NULL DEFAULT false;
