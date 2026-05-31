# Agent instructions

## Project overview

This repository is an npm library written in TypeScript and managed with Bun.

## Development workflow

- Install dependencies with `bun install`.
- Run tests with `bun test`.
- Build the package with `bun run build`.
- Run type checking with `bun run typecheck`.
- Format the codebase with `bun run format` (uses `oxfmt`; rules live in `.oxfmtrc.json`).
  Check formatting in CI / before pushing with `bun run format:check`.
- Keep source files in `src/` and tests in `test/`.

## Coding guidelines

- Prefer small, focused TypeScript modules with explicit exported types.
- Keep public APIs documented in `README.md`.
- Add or update tests for behavior changes.
- Do not commit generated dependencies such as `node_modules/`.
- Do not hand-reformat code. Run `bun run format` so changes match the project's `oxfmt` rules.

## VM guidelines

- Security is a top priority. Avoid introducing vulnerabilities or regressions
- Don't implement any features that will jeopardize the security of the VM.
- Ensure maximum parity of our VM with existing ECMAScript specifications and behaviors for web browsers.
- Testing against the test262 suite is a requirement for any new features or changes to the VM. This ensures that our implementation is compliant with the ECMAScript specification and behaves as expected in various scenarios.
- Never expose any Host APIs, objects, or prototypes to the VM. At most, the VM should mirror the behavior of the global object and its prototypes, but should not have access to any Host APIs or objects. This is crucial for maintaining the security and integrity of the VM, as exposing Host APIs could potentially allow malicious code to access sensitive information or perform unauthorized actions.
- Any data or information that needs to be shared between the Host and the VM should be done through a secure and controlled interface, such as serialization and reconstruction system, or a sandboxed API. This allows for communication between the Host and the VM while still maintaining strict boundaries and preventing unauthorized access to Host resources.
- Enforce a secure-by-default approach in the design and implementation of the VM. 
