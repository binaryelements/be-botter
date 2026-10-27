-- The backup taken before a company reset runs as the runtime role, so it may read (never
-- change) the migration history; a restored dump then knows which migrations it has.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT ON TABLE "_prisma_migrations" TO rakazo_app;
  END IF;
END $$;
