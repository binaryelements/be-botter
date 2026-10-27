import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { pruneResetBackups } from "./reset-backup.js";

const DAY = 24 * 60 * 60 * 1000;
let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("deletes reset backups older than seven days and nothing else", async () => {
  dir = mkdtempSync(path.join(tmpdir(), "reset-backups-"));
  const now = Date.now();
  const files = {
    "reset-old.dump": now - 8 * DAY,
    "reset-recent.dump": now - 6 * DAY,
    "other-old.dump": now - 30 * DAY,
  };
  for (const [name, at] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), "x");
    utimesSync(path.join(dir, name), at / 1000, at / 1000);
  }
  await pruneResetBackups(dir, now);
  expect((await readdir(dir)).sort()).toEqual(["other-old.dump", "reset-recent.dump"]);
});
