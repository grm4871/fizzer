# Contributor agent instructions

## Prefer less code

Before adding code, consider whether the task can be solved by deleting,
simplifying, reusing, or combining existing code. Remove superseded paths when
consolidating behavior.

## Verification

- Run `npm run build` before pushing to `master`.
- For client changes, run `npm run test:release:frontend` and load the built app
  with `npm run verify:client-runtime`.
- For backend or agent-server changes, run `npm run test:release:backend`.
- For Electron main-process, runner, or packaging changes, run
  `npm run test:release:desktop`.
- Use `docs/release-matrix.md` to select any additional flow-specific checks.

The public repository does not contain or operate a production deployment.
Self-hosters should adapt `docs/deployment.md` to their own infrastructure and
must not assume the maintainers' hosting configuration or credentials.

## Compatibility names

The `CASCADE_*` environment variables, `~/.cascade` data directory, Elixir
`Cascade` modules, `cascade-*` helper commands, and some internal paths are
retained for compatibility. New user-facing text should use the Fizzer name;
do not mechanically rename compatibility identifiers without a migration plan.
