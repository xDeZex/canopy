## Workflow

Use Conventional Commits for commits pushed to `main`.
One feature is one commit. Squash related commit before pushing to main.

Before starting a task or exploration in a new session, create a dedicated Git worktree from origin/main and move the OpenCode session into it.
Name worktree directories in lowercase kebab-case as `issue-<number>-<short-purpose>` for issue-linked work or `<type>-<short-purpose>` (such as `explore-session-recovery`) otherwise.
You are allowed to install existing locked dependencies in worktrees.
Review changes against the commit the worktree started from.

## Coding standards

Read `CODING_STANDARDS.md` before making changes.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
