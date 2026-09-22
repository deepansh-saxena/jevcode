# Repository workflow

These instructions apply to coding agents maintaining Jev Code.

- Keep changes focused on the requested task and preserve unrelated local edits.
- Validate changes with the relevant tests and `npm run check`; rebuild the CLI
  with `npm run build` when its source changes.
- The owner wants ongoing version history: commit completed, validated,
  task-scoped changes and push them to the configured GitHub remote by default,
  unless the user asks otherwise. Do not leave a completed task uncommitted.
- If committing or pushing is blocked, report the blocker and the local state.
  Do not rewrite published history or force-push without explicit permission.
- The repository is `deepansh-saxena/jevcode`. Verify the GitHub account before
  repository operations; do not change global authentication settings.
- Never commit credentials, `.env` files, `.jev/` workspace state,
  `.jev-code/` authentication data, `node_modules/`, or generated `dist/` files.
- Review the staged files before committing. Keep credentials out of remote
  URLs, logs, commit messages, and documentation.
