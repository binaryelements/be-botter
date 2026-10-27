# BE Botter fork

BE Botter is a hard fork of Rakazo, taken at tag `be-freeze-20261023`. We do not merge upstream
wholesale: upstream moves faster than we can follow (hundreds of commits a week), and most of the
files we changed keep changing upstream. Instead we take upstream changes on purpose, one at a time.

## What we take from upstream

- **Security fixes:** always, as soon as they are seen.
- **Bug fixes in code we run:** auth, the agent runtime, connectors, the computer and supervisor,
  the database layer.
- **Features:** only when someone asks for them; they are ported like any other feature, with a PR
  of their own.

Everything else is skipped. Mobile and desktop changes are skipped until we ship those apps.

## Weekly upstream review

```sh
git fetch upstream
git log --oneline --no-merges "$(git describe --tags --abbrev=0 --match 'be-upstream-*' 2>/dev/null || echo be-freeze-20261023)..upstream/main"
```

Read the list, pick what the rules above keep, and bring each pick over with
`git cherry-pick -x <sha>` on a branch named `upstream/<topic>`, through a normal PR. When the
review is done, tag the upstream commit you reviewed up to:

```sh
git tag be-upstream-YYYYMMDD upstream/main && git push origin be-upstream-YYYYMMDD
```

Upstream migrations keep their folder names when cherry-picked. `prisma migrate deploy` applies
every migration that has not run yet, including ones whose folder sorts before ours. They still
follow the deploy rule in `AGENTS.md`: additive first, drops in a later release.

## Where BE Botter differs

New modules, owned by the fork:

| Area | Server | Web |
| --- | --- | --- |
| Departments, access and channels | `packages/db/src/departments.ts`, `bot-threads.ts`, `department-admin.ts` | `components/DepartmentsSettings.tsx`, `pages/shell/bot-departments.tsx`, `pages/shell/thread-switch.tsx` |
| Company space and model connection | `packages/db/src/company-space.ts`, `apps/api/src/company-model.ts` | `pages/model-settings/company-model.tsx` |
| Company connections | `apps/api/src/connection-admin.ts`, `packages/auth/src/person-token.ts` | `components/ConnectionsAdminOnlySetting.tsx`, `lib/connections-access.ts` |
| Admin tools on bots | `packages/adapters/src/admin-tools.ts`, `docs/admin-tools.md` | |
| Audit | | `components/AuditLog.tsx` |

Upstream files we changed most, where cherry-picks are most likely to conflict:
`apps/api/src/router.ts`, `apps/web/src/pages/Shell.tsx`, `packages/adapters/src/executor.ts`,
`packages/db/prisma/schema.prisma`, `packages/ui-tokens/src/index.ts` (BE Hub palette),
`infra/compose/Dockerfile` (server-only image), `.github/workflows/publish-server-image.yml`
(publishes from `be-main`), and the brand assets under `apps/web/public`.

## Keeping the fork cheap to maintain

- Put new behaviour in a module of its own and call it from upstream files in as few lines as
  possible.
- Add a row above when a feature adds a module, and list any upstream file it changes heavily.
- Never rename or reformat upstream code just to tidy it.
