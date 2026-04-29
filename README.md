# vmjs

VMJS is a TypeScript library for creating secure-by-default JavaScript virtual machines in JavaScript. It is intended for browser-compatible hosts and for applications that need an explicit boundary between host code and guest-authored JavaScript.

Guest source is parsed into an AST and executed by VMJS's own interpreter. VMJS does **not** execute guest source with host `eval`, indirect `eval`, `Function`, `AsyncFunction`, or dynamic `import()`.

> Status: early implementation. The public API below reflects what is implemented today. Do not treat VMJS as a replacement for process, worker, iframe, or OS-level sandboxing when you need hard resource isolation.

## Installation

```sh
bun add vmjs
```

```ts
import { VM, networkRule, VMErrorCode } from "vmjs";
```

## Quick start

```ts
import { VM } from "vmjs";

const vm = new VM({
  globals: {
    console: {
      log(message) {
        console.log("guest:", message);
      },
    },
    data: { count: 1 },
  },
  capabilities: {
    executionRules: { timeLimit: 100 },
    numbers: { randomSeed: "demo", dateNow: 1_697_059_200_000 },
  },
});

await vm.start();

const result = await vm.evaluate("console.log(data.count); data.count + 1");
if (result.ok) {
  console.log(result.value); // 2
} else {
  console.error(result.error.code, result.error.message);
}

vm.dispose();
```

## Execution architecture

VMJS uses a custom parser/interpreter pipeline:

1. `parseProgram()` parses source with Acorn and produces an AST. Parsing does not execute source.
2. The interpreter walks supported AST nodes inside VM-owned lexical/global environments.
3. Guest objects are represented as VM-owned arrays or null-prototype records, and callable host globals are represented as explicit capabilities.

The host/guest boundary is serialization-only:

- Initial `globals` are serialized and reconstructed before entering the VM. Host functions are not shared; they are installed as revocable capabilities.
- Capability arguments are serialized/reconstructed before the host handler receives them, and capability results are serialized/reconstructed before returning to guest code.
- `eval()`/`evaluate()` results are serialized/reconstructed before being returned to the host.
- Snapshots store tagged serialized values and `VM.fromSnapshot()` reconstructs fresh values.

Host object identity, mutable references, prototypes, accessors, symbols, promises, functions, weak collections, cycles, and shared object graphs do not cross as ordinary values.

## Public API

### `VM`

```ts
const vm = new VM(options?: VMOptions);
await vm.start();
const result = await vm.eval(source, options?);
const sameResult = await vm.evaluate(source, options?);
await vm.idle();
const snapshot = vm.snapshot();
vm.reset();
vm.dispose();
const restored = VM.fromSnapshot(snapshot);
```

Lifecycle:

- `new VM()` creates an unstarted VM. Call `await vm.start()` before evaluation, snapshots, or `idle()`.
- `start()` initializes the VM scope. Calling it more than once is a no-op unless the VM was disposed.
- `eval(source, options?)` is an alias for `evaluate(source, options?)`.
- `idle()` waits for a small number of microtask turns. It is a convenience for currently pending promises, not a full event-loop implementation.
- `reset()` discards current guest globals and reinstalls the initial globals/options. The VM remains started.
- `snapshot()` returns serializable guest state and selected options. It fails if the VM contains host capabilities/callable globals.
- `VM.fromSnapshot(snapshot)` restores a VM from a snapshot.
- `dispose()` revokes installed capabilities, drops VM state, and makes further use fail with `VM_DISPOSED`.

### Options

```ts
interface VMOptions {
  capabilities?: {
    executionRules?: { timeLimit?: number };
    numbers?: { randomSeed?: string | number; dateNow?: number };
    networkingRules?: readonly (NetworkRuleDefinition | NetworkRuleBuilder)[];
  };
  globals?: Record<string, VMGlobalValue>;

  // Also accepted as top-level aliases; top-level values override capabilities.*.
  executionRules?: { timeLimit?: number };
  numbers?: { randomSeed?: string | number; dateNow?: number };
}
```

`globals` are the only way to expose host-provided values to guest code. Supported global values are boundary-serializable values, nested arrays/plain objects, and functions. Functions are installed as explicit capabilities and are called through the VM boundary.

Global names must be normal JavaScript identifiers. Names such as `constructor`, `prototype`, `__proto__`, `fetch`, `Function`, and `AsyncFunction` are not special-cased as forbidden: if they exist inside the VM, they are VM-owned bindings or explicit host-provided capabilities, not ambient host references. Object and array globals must use enumerable data properties only; accessors and symbol properties are rejected.

Built-in globals currently installed by default include `undefined`, `NaN`, `Infinity`, safe subsets of `Math`, `Date`, `JSON`, `Object`, `Array`, and primitive conversion helpers. `typeof` for unknown globals reports `"undefined"`; directly reading an unknown binding produces a structured runtime error. `fetch` and `XMLHttpRequest` are not available as ambient browser APIs, but a host can explicitly provide a `fetch` capability if desired.

### Evaluation results

`eval()` and `evaluate()` always resolve to a structured result instead of throwing guest syntax/runtime/security failures:

```ts
type VMResult<T = VMSerializableValue> =
  | { ok: true; value: T }
  | { ok: false; error: VMError };
```

Returned values are cloned across the boundary. Host object identity, prototypes, accessors, symbols, functions, promises, weak collections, and cycles do not cross as ordinary values.

VM lifecycle misuse can still throw directly, for example using a VM before `start()` or after `dispose()`.

### Capabilities and boundary helpers

The boundary API is exported for callers that need explicit serialization or callable capabilities:

```ts
import {
  VMError,
  VMErrorCode,
  cloneBoundaryValue,
  createCapability,
  invokeBoundaryCapability,
  isBoundarySerializable,
  isVMCapability,
  isVMCapabilityReference,
  reconstructBoundaryValue,
  serializeBoundaryValue,
} from "vmjs";
```

Supported boundary values are primitives, arrays, plain objects, `Date`, `RegExp`, `Map`, `Set`, `ArrayBuffer`, typed arrays, `DataView`, and explicit capabilities. Cloned plain objects are reconstructed without host prototypes.

`createCapability(name, handler, options?)` wraps a host function. Arguments passed to the handler are cloned first, and handler results are cloned before returning to the caller. Capabilities can be revoked; invoking a revoked capability fails with `BOUNDARY_CAPABILITY_REVOKED`.

`serializeBoundaryValue()` produces tagged data, `reconstructBoundaryValue()` / `deserializeBoundaryValue()` reconstruct it, `cloneBoundaryValue()` serializes and reconstructs in one step, and `isBoundarySerializable()` checks support without returning the value.

Errors use `VMError` with a `code` from `VMErrorCode` and optional `details`. Current codes cover unsupported boundary values, cycles, invalid serialized data, revoked capabilities, VM syntax/runtime/security/timeout failures, disposed/not-started VMs, and unsupported snapshots.

## Security model

VMJS is secure-by-default in the sense that a new VM exposes no ambient host globals, networking, filesystem, timers, DOM, `process`, `window`, `globalThis`, dynamic import, host `Function`, or host objects by default.

The intended model is:

- Host and guest communicate only through VM APIs and explicitly provided globals/capabilities.
- Values crossing the boundary are serialized and reconstructed; callable globals are represented as capabilities whose arguments and results are also serialized and reconstructed.
- Guest mutation of cloned data does not mutate the original host object.
- Capabilities should be narrow, named, auditable host functions.
- The interpreter prevents host escape by never exposing host globals, host prototypes, or host constructors by default. Constructor-like property names are allowed as VM-owned data, but resolving them cannot jump to host prototypes or the host `Function` constructor.

This implementation is still browser-compatible JavaScript running in the same JavaScript engine as the host. It does not provide process-level memory isolation, OS sandboxing, or hard CPU preemption.

## Supported JavaScript subset

VMJS parses modern JavaScript syntax, but the interpreter intentionally supports only a small subset today. It does not claim full ECMAScript conformance.

Currently supported guest code includes:

- expression statements, blocks, `if`, `while`, basic `for`, `break`, `continue`, and `return` inside guest functions;
- `var`, `let`, and `const` declarations with simple identifier bindings;
- number/string/boolean/null/bigint literals, array literals, plain object literals with data properties, template literals, conditional expressions, sequence expressions, and `await`;
- function declarations, function expressions, arrow functions, and basic async/await flows;
- assignment/update operators, arithmetic/comparison/equality/bitwise operators, `in`, logical operators, nullish coalescing, unary `!`, `+`, `-`, `~`, `typeof`, `void`, and `delete`;
- member reads/writes/deletes on VM-owned arrays and plain objects, including computed property keys;
- safe callable subsets of `Math`, `Date`, `JSON`, `Object`, `Array`, `Number`, `String`, `Boolean`, and `BigInt`.

Known unsupported or intentionally denied features include:

- built-in guest implementations of `eval`, indirect `eval`, `Function`, `AsyncFunction`, `Reflect`, `Proxy`, `fetch`, and `XMLHttpRequest` unless the host explicitly provides safe capabilities for those names;
- modules/import/export during `VM.evaluate()`, dynamic `import()`, classes, `new`, constructors, prototype reflection/mutation, `this`-based global access, `super`, private fields, generators/yield, and `with`;
- `switch`, `try`/`catch`/`finally`, `do...while`, `for...in`, `for...of`, labels, destructuring, rest/spread, optional chaining, object methods/getters/setters, and RegExp literals;
- direct access to prototype methods on guest values, a full standard library, a guest `Promise` constructor, or a managed event loop.

Unsupported syntax generally produces a structured `VM_RUNTIME_ERROR` with `details.reason === "unsupported syntax"`. Missing or unconfigured globals such as `window`, `process`, or `fetch` generally produce `VM_RUNTIME_ERROR`; actual denied escape paths such as dynamic import or `this`-based global access produce `VM_SECURITY_ERROR`.

## Resource limits

`executionRules.timeLimit` and per-call `evaluate(source, { timeLimit })` provide a best-effort wall-clock guard:

- the interpreter checks a cooperative execution budget at statements, expressions, and loop iterations;
- infinite or long-running interpreted loops can be stopped at checkpoints;
- browser-compatible JavaScript cannot synchronously interrupt arbitrary running code.

Therefore time limits are guardrails, not hard CPU guarantees. A synchronous host capability can still block while it runs, and there is currently no independent memory limit, public instruction counter, scheduler, or deterministic event loop.

## Deterministic numbers and time

`capabilities.numbers.randomSeed` replaces guest `Math.random()` with a deterministic seeded generator. When omitted, `Math.random()` delegates to the host's non-deterministic randomness.

`capabilities.numbers.dateNow` fixes guest `Date.now()` to a specific timestamp. When omitted, `Date.now()` delegates to the host clock. Other numeric behavior uses normal JavaScript number/bigint operations and is not a separate deterministic numeric engine.

## Networking

`networkRule(host)` builds immutable, serializable network policy definitions:

```ts
import { networkRule } from "vmjs";

const rule = networkRule("example.com")
  .allow({ methods: ["GET"], paths: ["/api/*", "/home"] })
  .setHeaders({ "X-API-Key": "secret" });

JSON.stringify(rule);
```

- `networkRule(host)` accepts a host name only: no scheme, path, query, fragment, credentials, or whitespace.
- Rules start with no allowed methods or paths.
- `.allow()` with no options allows all methods and paths.
- `.allow({ methods, paths })` accepts supported uppercase HTTP methods and path globs that start with `/`.
- `.setHeaders(headers)` validates header names and rejects CR/LF in values.
- Builders and their JSON definitions are frozen.

Current networking status: rules can be passed in `capabilities.networkingRules`, normalized, and included in snapshots, but guest `fetch`/`XMLHttpRequest` host mediation is not implemented yet. Network rules alone do not install a `fetch` global. Guest `fetch(...)` fails as an unconfigured runtime call by default, while an explicit host-provided `fetch` capability can be called through the normal serialization-only boundary.

## Snapshots

`snapshot()` serializes current global bindings other than VMJS base globals and reconstructs them when restored. Snapshots are value copies, not shared state.

Current limitations:

- the VM must be started and not disposed;
- VMs with host capabilities/callable globals cannot be snapshotted;
- guest functions/callables, cycles, promises, weak collections, and unsupported boundary values cannot be snapshotted;
- pending async work, host capability state, timers, network state, and an event loop are not captured;
- snapshot format version is currently `1` and should be treated as early.

## Browser compatibility

The runtime source in `src/` avoids Node.js, Bun-only, filesystem, process, native-addon, and server-only APIs. It uses standard JavaScript APIs such as `URL`, promises, `Date`, `Math`, `Map`, `Set`, `Reflect.ownKeys`, `ArrayBuffer`, and typed arrays. It does not rely on host `eval`, `Function`, `AsyncFunction`, or dynamic import for guest execution.

Bun is used for development workflows: dependency installation, tests, and package build scripts. The package is ESM-first and written in TypeScript. Browser compatibility is a source-level design goal; a dedicated browser test/build matrix has not been added yet.

## ECMAScript and test262 status

VMJS does not currently integrate test262 and does not claim full ECMAScript conformance. Source is parsed with Acorn and evaluated by the VMJS interpreter, so runtime support is limited to the implemented AST nodes and VM-owned built-ins listed above.

Adding test262 coverage is a project goal, but there is currently no test262 runner or published pass list.

## Development

Install dependencies:

```sh
bun install
```

Run tests:

```sh
bun test
```

Build the library:

```sh
bun run build
```

Run type checking:

```sh
bun run typecheck
```
