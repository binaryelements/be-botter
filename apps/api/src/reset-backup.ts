import { execFile } from "node:child_process";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_BACKUP = /^reset-.*\.dump$/;

/**
 * Dumps the whole database before a company reset and returns the file name. Without a migration
 * URL the runtime role dumps it, reading every row through the RLS bypass.
 */
export function resetBackup(env: { dataDir: string; databaseUrl: string; migrationUrl?: string }) {
  return async (): Promise<string> => {
    const dir = path.join(env.dataDir, "backups");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const name = `reset-${new Date().toISOString()}.dump`;
    const file = path.join(dir, name);
    // The password goes through the environment so it never shows in the process list.
    const url = new URL(env.migrationUrl ?? env.databaseUrl);
    const password = decodeURIComponent(url.password);
    url.password = "";
    const runtime = env.migrationUrl ? [] : ["--enable-row-security"];
    try {
      await run(
        "pg_dump",
        ["--format=custom", `--file=${file}`, ...runtime, `--dbname=${url.toString()}`],
        {
          env: {
            ...process.env,
            PGPASSWORD: password,
            ...(env.migrationUrl ? {} : { PGOPTIONS: "-c app.rls_bypass=on" }),
          },
        },
      );
    } catch (error) {
      await rm(file, { force: true });
      throw error;
    }
    await pruneResetBackups(dir, Date.now());
    return name;
  };
}

/** Deletes reset backups older than seven days. */
export async function pruneResetBackups(dir: string, now: number): Promise<void> {
  for (const entry of await readdir(dir)) {
    if (!RESET_BACKUP.test(entry)) continue;
    const file = path.join(dir, entry);
    if (now - (await stat(file)).mtimeMs > KEEP_MS) await rm(file, { force: true });
  }
}
