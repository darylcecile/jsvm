# Agent instructions

## Project overview

This repository is an npm library written in TypeScript and managed with Bun.

## Development workflow

- Install dependencies with `bun install`.
- Run tests with `bun test`.
- Build the package with `bun run build`.
- Run type checking with `bun run typecheck`.
- Keep source files in `src/` and tests in `test/`.

## Coding guidelines

- Prefer small, focused TypeScript modules with explicit exported types.
- Keep public APIs documented in `README.md`.
- Add or update tests for behavior changes.
- Do not commit generated dependencies such as `node_modules/`.
