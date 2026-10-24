-- Who sent a user message. Department channels are written by several people, so a
-- reader needs the sender on each message; private threads have one writer and leave it
-- null in old rows. Additive, so the previous release keeps working beside this one.
ALTER TABLE "messages" ADD COLUMN "userId" TEXT;
