-- Whether a signed-in person made the routine themselves. Additive with a safe default: the
-- previous release never reads it, and existing routines count as not made in person.
ALTER TABLE "routines" ADD COLUMN "personCreated" BOOLEAN NOT NULL DEFAULT false;
