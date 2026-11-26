# Git workflow

## Commits
- Conventional Commits. Write the subject in lowercase and describe the behavior change, not the edit. Examples from the log: `fix: answer an unknown MCP session id with 404`, `fix: keep the serving role's grants when an ingest swaps tables`. Types in use: `feat`, `fix`, `test`, `docs`, `refactor`, `perf`, `ci`, `build`.
- The body, wrapped at about 72 columns, is prose: the concrete failure scenario, why it happened, and what the change does about it. Don't list files.
- One logical change per commit, with its tests and README updates in the same commit.
- Eclipse ECA: every commit carries `Signed-off-by:` (`git commit -s`).
- Never commit `config*.local.json`, `*.db*`, `*.tmp*`, `models/`, `.cache/`, `dist/`, or `.claude/settings.local.json`. `docs/superpowers/` and `.superpowers/` hold local design notes and are excluded through `.git/info/exclude`; never add them.

## Before calling a change done
Run `npm run typecheck && npm test`. If you touched Postgres or ingest code (`pg-*`, `ingest-store.ts`, `build-index.ts`), also run `npm run test:pg` (needs Docker). CI runs all three on every PR and on `main`.

## Keep the agent instructions current
Whenever you add, move, rename, or delete a source file, or change an invariant written down in the instructions, update the code map in the root `AGENTS.md` and the matching `.claude/rules/*.md` in the same commit. A stale map is worse than none. When a rule file is added, renamed, or re-scoped, update the rules index at the end of `AGENTS.md` as well; agents other than Claude Code find the rules only through it.
