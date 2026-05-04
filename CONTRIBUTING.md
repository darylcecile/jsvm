# Contributing to JSVM

Thanks for taking the time to contribute.

## Quick start

- Install dependencies: `bun install`
- Run tests: `bun test`
- Typecheck: `bun run typecheck`
- Build: `bun run build`

## Development workflow

1. Create a branch from `main`.
2. Keep changes focused and small.
3. Add or update tests for behavior changes.
4. Run `bun test` and `bun run typecheck` before opening a PR.

## VM security guidelines

Security is the top priority for this project. Please follow these rules:

- Do not expose Host APIs, objects, or prototypes to the VM.
- Preserve the host/guest boundary; values must serialize and reconstruct.
- Prefer secure-by-default designs and avoid new ambient capabilities.
- Do not introduce features that weaken isolation or allow host escape.

## ECMAScript compatibility

- Maintain parity with ECMAScript behavior as implemented today.
- If you add or change language features, add tests.
- Running test262 is required for language changes. Use:
  - `bun run test262`
  - Optionally pass `TEST262_DIR=../test262` or `--test262-dir`.

## Commit and PR guidance

- Use clear commit messages.
- Describe intent, behavior changes, and tests in the PR.
- If the change affects public APIs, update `README.md`.

## Code style

- Prefer small, focused TypeScript modules with explicit exported types.
- Avoid adding generated artifacts like `node_modules`.
