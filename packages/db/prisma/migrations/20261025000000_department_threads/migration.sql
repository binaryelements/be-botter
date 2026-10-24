-- Many threads per bot. The creator's existing thread stays the bot's home thread
-- (bots.homeThreadId), other people get their own private thread, and a department gets
-- one channel per bot (threads.departmentId). Additive only: the previous release finds a
-- bot's thread by botId with a plain WHERE, so dropping the unique index is safe while
-- both releases run.
ALTER TABLE "threads" ADD COLUMN "departmentId" TEXT;
ALTER TABLE "threads" ADD CONSTRAINT "threads_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
DROP INDEX "threads_botId_key";
CREATE INDEX "threads_botId_idx" ON "threads"("botId");
CREATE INDEX "threads_departmentId_idx" ON "threads"("departmentId");
-- One channel per bot per department, one private thread per bot per person. Partial
-- indexes, which the Prisma schema cannot express; group and external threads have no bot.
CREATE UNIQUE INDEX "threads_bot_channel_key" ON "threads"("botId", "departmentId")
    WHERE "departmentId" IS NOT NULL;
CREATE UNIQUE INDEX "threads_bot_private_key" ON "threads"("botId", "userId")
    WHERE "botId" IS NOT NULL AND "departmentId" IS NULL;

ALTER TABLE "bots" ADD COLUMN "homeThreadId" TEXT;
CREATE UNIQUE INDEX "bots_homeThreadId_key" ON "bots"("homeThreadId");
ALTER TABLE "bots" ADD CONSTRAINT "bots_homeThreadId_fkey"
    FOREIGN KEY ("homeThreadId") REFERENCES "threads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- Every existing bot has exactly one thread; it becomes the home thread.
UPDATE "bots" SET "homeThreadId" = t."id" FROM "threads" t WHERE t."botId" = "bots"."id";

CREATE TABLE "thread_reads" (
    "threadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lastReadSeq" INTEGER NOT NULL DEFAULT -1,
    "unread" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "thread_reads_pkey" PRIMARY KEY ("threadId", "userId")
);
ALTER TABLE "thread_reads" ADD CONSTRAINT "thread_reads_threadId_fkey"
    FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security through the thread, in the shape of messages_tenant.
ALTER TABLE "thread_reads" ENABLE ROW LEVEL SECURITY;
CREATE POLICY thread_reads_tenant ON "thread_reads"
  USING (EXISTS (
    SELECT 1 FROM "threads" t
    WHERE t."id" = "thread_reads"."threadId"
      AND t."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ));
CREATE POLICY thread_reads_system ON "thread_reads"
  USING (current_setting('app.rls_bypass', true) = 'on');
