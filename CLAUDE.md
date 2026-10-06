## Workflow

Use Conventional Commits for commits pushed to `main`.
One feature is one commit. Squash related commit before pushing to main.
When a commit fully resolves an issue, include a closing reference in its message (for example, `Closes #123`) so GitHub closes the issue when the commit reaches `main`.

Before starting a task or exploration in a new session, use this worktree setup:

1. Read the issue, if provided. Choose a lowercase kebab-case worktree name: `issue-<number>-<short-purpose>` for issue-linked work, or `<type>-<short-purpose>` (such as `explore-session-recovery`) otherwise.
2. Fetch `origin/main` and resolve the current OpenCode project ID through its location API.
3. Ensure the project's worktree startup command (`commands.start`) is `npm ci`. Set it through the project API if absent; ask before replacing a different startup command. This is local OpenCode project state, not checked-in configuration.
4. Create the worktree through OpenCode's `worktree.create` API with `branch: "origin/main"` and the chosen `name`. `from`, if supplied, is an existing checkout directory belonging to the project, not a Git ref; `directory`, if supplied, is the destination parent directory.
5. Confirm startup completed successfully and dependencies are installed in the returned directory. If the checkout is detached, create a task branch there using the chosen name.
6. Move the OpenCode session into the returned directory before starting work, and record its starting commit for review.

If API creation or startup fails, stop and explain the failure. Obtain user approval before falling back to manual Git worktree creation or dependency setup.
You are allowed to install existing locked dependencies in worktrees.
Review changes against the commit the worktree started from.

## User comments

Read `.canopy/comments.yaml`, if it exists, to find the user's comments on code.

## Coding standards

Read `CODING_STANDARDS.md` before making changes.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
