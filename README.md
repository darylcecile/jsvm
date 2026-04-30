# @catmint-fs/jsvm

JSVM is a TypeScript library for creating secure-by-default JavaScript virtual machines in JavaScript. It is intended for browser-compatible hosts and for applications that need an explicit boundary between host code and guest-authored JavaScript.

Guest source is parsed into an AST and executed by JSVM's own interpreter. JSVM does **not** execute guest source with host `eval`, indirect `eval`, `Function`, `AsyncFunction`, or dynamic `import()`.

> Status: early implementation. The public API below reflects what is implemented today. Do not treat JSVM as a replacement for process, worker, iframe, or OS-level sandboxing when you need hard resource isolation.

## Installation

```sh
bun add @catmint-fs/jsvm
```

```ts
import { VM, networkRule, VMErrorCode } from "@catmint-fs/jsvm";
```

## Quick start

```ts
import { VM } from "@catmint-fs/jsvm";

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

JSVM uses a custom parser/interpreter pipeline:

1. `parseProgram()` parses source with Acorn and produces an AST. Parsing does not execute source.
2. The interpreter walks supported AST nodes inside VM-owned lexical/global environments.
3. Guest objects are represented as VM-owned arrays or null-prototype records, and callable host globals are represented as explicit capabilities.

The host/guest boundary is serialization-only:

- Initial `globals` are serialized and reconstructed before entering the VM. Host functions are not shared; they are installed as revocable capabilities.
- Capability arguments are serialized/reconstructed before the host handler receives them, and capability results are serialized/reconstructed before returning to guest code.
- `eval()`/`evaluate()` results are serialized/reconstructed before being returned to the host. Enumerable guest getters are invoked during this export and their current values are cloned.
- Snapshots store tagged serialized values and `VM.fromSnapshot()` reconstructs fresh values. Enumerable guest getters are invoked while snapshotting.

Host object identity, mutable references, prototypes, accessors, symbols, promises, functions, weak collections, cycles, and shared object graphs do not cross as ordinary values.

## Public API

### `VM`

```ts
const vm = new VM(options?: VMOptions);
await vm.start();
const result = await vm.eval(source, options?);
const sameResult = await vm.evaluate(source, options?);
await vm.idle();
const snapshot = await vm.snapshot();
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
- `snapshot()` resolves to serializable guest state and selected options. It fails if the VM contains host capabilities/callable globals.
- `VM.fromSnapshot(snapshot)` restores a VM from a snapshot.
- `dispose()` revokes installed capabilities, drops VM state, and makes further use fail with `VM_DISPOSED`.

### Options

```ts
interface VMOptions {
  capabilities?: {
    executionRules?: { timeLimit?: number };
    numbers?: { randomSeed?: string | number; dateNow?: number };
    networkingRules?: readonly (NetworkRuleDefinition | NetworkRuleBuilder)[];
    moduleLoader?: VMModuleLoader;
    dynamicCode?: boolean;
  };
  globals?: Record<string, VMGlobalValue>;

  // Also accepted as top-level aliases; top-level values override capabilities.*.
  executionRules?: { timeLimit?: number };
  numbers?: { randomSeed?: string | number; dateNow?: number };
}
```

`globals` are the only way to expose host-provided values to guest code. Supported global values are boundary-serializable values, nested arrays/plain objects, and functions. Functions are installed as explicit capabilities and are called through the VM boundary.

`capabilities.dynamicCode` defaults to `false`. When set to `true`, the VM installs VM-owned interpreted `eval`, `Function`, and `AsyncFunction` globals. These parse source strings and execute through the interpreter; they still do not use host `eval`, `Function`, `AsyncFunction`, or dynamic `import()`.

`capabilities.moduleLoader` is the only way ES modules can load dependencies. `evaluate(source, { sourceType: "module" })` evaluates an entry module and returns its module namespace as a cloned object. Static imports, named/default exports, namespace imports, and basic re-exports are resolved through `moduleLoader.resolve()` and `moduleLoader.load()`; a VM without a loader default-denies every dependency. The loader supplies source strings explicitly and JSVM never reads from the filesystem, network, dynamic `import()`, or host module cache. Cyclic module graphs currently fail with a structured `VM_RUNTIME_ERROR`.

Global names must be normal JavaScript identifiers. Names such as `constructor`, `prototype`, `__proto__`, `fetch`, `Function`, and `AsyncFunction` are not special-cased as forbidden: if they exist inside the VM, they are VM-owned bindings or explicit host-provided capabilities, not ambient host references. Object and array globals must use enumerable data properties only; accessors and symbol properties are rejected.

Built-in globals currently installed by default include `undefined`, `NaN`, `Infinity`, a safe subset of `Math`, VM-owned intrinsics for `Object`, `Array`, `String`, `Number`, `Boolean`, `RegExp`, `Date`, `Map`, `Set`, `Reflect`, and `Proxy`, `JSON`, `BigInt`, and VM-owned `fetch`/`XMLHttpRequest` networking surfaces. `typeof` for unknown globals reports `"undefined"`; directly reading an unknown binding produces a structured runtime error. Networking surfaces are not ambient browser APIs: they are VM-owned wrappers that serialize request data to the host, enforce `networkingRules`, let the host perform real networking, then reconstruct response data in the guest realm.

### Evaluation results

`eval()` and `evaluate()` always resolve to a structured result instead of throwing guest syntax/runtime/security failures:

```ts
type VMResult<T = VMSerializableValue> =
  | { ok: true; value: T }
  | { ok: false; error: VMError };
```

Returned values are cloned across the boundary. Enumerable guest accessors are invoked and exported as data values; host object identity, prototypes, accessors, symbols, functions, promises, weak collections, and cycles do not cross as ordinary values.

VM lifecycle misuse can still throw or reject directly, for example using a VM before `start()` or after `dispose()`.

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
} from "@catmint-fs/jsvm";
```

Supported boundary values are primitives, arrays, plain objects, `Date`, `RegExp`, `Map`, `Set`, `ArrayBuffer`, typed arrays, `DataView`, and explicit capabilities. Cloned plain objects are reconstructed without host prototypes.

Inside guest code, imported `ArrayBuffer`, typed array, and `DataView` values are VM-owned boundary copies with basic byte-length metadata; typed array/DataView prototype methods are not implemented yet.

`createCapability(name, handler, options?)` wraps a host function. Arguments passed to the handler are cloned first, and handler results are cloned before returning to the caller. Capabilities can be revoked; invoking a revoked capability fails with `BOUNDARY_CAPABILITY_REVOKED`.

`serializeBoundaryValue()` produces tagged data, `reconstructBoundaryValue()` / `deserializeBoundaryValue()` reconstruct it, `cloneBoundaryValue()` serializes and reconstructs in one step, and `isBoundarySerializable()` checks support without returning the value.

Errors use `VMError` with a `code` from `VMErrorCode` and optional `details`. Current codes cover unsupported boundary values, cycles, invalid serialized data, revoked capabilities, VM syntax/runtime/security/timeout failures, disposed/not-started VMs, and unsupported snapshots.

## Security model

JSVM is secure-by-default in the sense that a new VM exposes no ambient host globals, networking, filesystem, timers, DOM, `process`, `window`, `globalThis`, dynamic import, host `Function`, or host objects by default.

The intended model is:

- Host and guest communicate only through VM APIs and explicitly provided globals/capabilities.
- Values crossing the boundary are serialized and reconstructed; callable globals are represented as capabilities whose arguments and results are also serialized and reconstructed.
- Guest mutation of cloned data does not mutate the original host object.
- Capabilities should be narrow, named, auditable host functions.
- The interpreter prevents host escape by never exposing host globals, host prototypes, or host constructors by default. Constructor-like property names are allowed as VM-owned data, but resolving them cannot jump to host prototypes or the host `Function` constructor.

This implementation is still browser-compatible JavaScript running in the same JavaScript engine as the host. It does not provide process-level memory isolation, OS sandboxing, or hard CPU preemption.

## Supported JavaScript subset

JSVM parses modern JavaScript syntax, but the interpreter intentionally supports only a small subset today. It does not claim full ECMAScript conformance.

Currently supported guest code includes:

- expression statements, blocks, `if`, `while`, `do...while`, basic `for`, `for...in`, `for...of`, `switch`, labels, `try`/`catch`/`finally`, `throw`, `break`, `continue`, and `return` inside guest functions;
- `var`, `let`, and `const` declarations with simple identifier bindings;
- number/string/boolean/null/bigint/RegExp literals, array literals with spread, plain object literals with data properties, object methods, object spread, template literals, conditional expressions, sequence expressions, and `await`;
- function declarations, function expressions, arrow functions, and basic async/await flows;
- class declarations and expressions, constructors, instance/static methods and accessors, public instance/static fields, `extends`, `super()`/`super.property`, and private fields/methods/accessors;
- ES module entry evaluation through `evaluate(source, { sourceType: "module" })`, with static imports, named/default exports, namespace imports, and basic re-exports mediated by an explicit module loader;
- assignment/update operators, spread call/constructor arguments for VM-supported callables/constructables, arithmetic/comparison/equality/bitwise operators, `in`, logical operators, nullish coalescing, unary `!`, `+`, `-`, `~`, `typeof`, `void`, and `delete`;
- member reads/writes/deletes on VM-owned arrays and plain objects, including computed property keys;
- safe callable subsets of `Math`, `JSON`, and `BigInt`, plus VM-owned common constructors/prototypes for `Object`, `Array`, `String`, `Number`, `Boolean`, `RegExp`, `Date`, `Map`, and `Set`, VM-owned `Reflect` methods, and VM-owned `Proxy` wrappers with guest trap invariant checks;
- optional VM-owned interpreted `eval`, `Function`, and `AsyncFunction` when `capabilities.dynamicCode` is enabled;
- VM-owned `fetch` and constructable `XMLHttpRequest` wrappers that mediate requests through the host network layer.

Known unsupported or intentionally denied features include:

- built-in guest implementations of `eval`, indirect `eval`, `Function`, and `AsyncFunction` unless `capabilities.dynamicCode` is enabled;
- cyclic module graphs, dynamic `import()`, advanced class features such as static initialization blocks, generators/yield, and `with`;
- a full standard library, typed array/DataView prototype methods, a guest `Promise` constructor, or a managed event loop.

Unsupported syntax generally produces a structured `VM_RUNTIME_ERROR` with `details.reason === "unsupported syntax"`. Missing or unconfigured globals such as `window` or `process` generally produce `VM_RUNTIME_ERROR`; denied network requests, dynamic import, and `this`-based global access produce `VM_SECURITY_ERROR`.

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
import { networkRule } from "@catmint-fs/jsvm";

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

Networking is host-mediated and default-deny:

- A new VM installs VM-owned `fetch` and `XMLHttpRequest` globals, but an empty `networkingRules` list blocks every request.
- Guest `fetch(url, init?)` serializes the URL, method, headers, and primitive body to the host. The host enforces rules, performs the real `globalThis.fetch`, reads the response body, and reconstructs a response-like guest object with `ok`, `status`, `statusText`, `url`, `headers.get()`, `headers.has()`, `text()`, `json()`, and `arrayBuffer()`.
- `new XMLHttpRequest()` constructs a VM-owned native object. `open()`, `setRequestHeader()`, `send()`, `getResponseHeader()`, and `getAllResponseHeaders()` are mediated through the same host network layer. `send()` is awaitable in the current implementation and relays `readystatechange`, `load`, `error`, and `loadend` callback properties.
- Rule headers are merged into allowed requests by the host. Requests that do not match a rule fail with `VM_SECURITY_ERROR`.

This is an early browser-compatible subset of fetch/XHR behavior, not a complete Web Platform implementation. Streaming bodies, binary upload bodies, abort signals, credentials/cache/mode/redirect/referrer options, upload progress, response types, and full event-target semantics are not implemented yet.

## Snapshots

`snapshot()` serializes current global bindings other than JSVM base globals and reconstructs them when restored. Snapshots are value copies, not shared state. Enumerable guest getters are invoked and stored as data values.

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

JSVM includes an opt-in test262 scaffold but does not claim full ECMAScript conformance. Source is parsed with Acorn and evaluated by the JSVM interpreter, so runtime support is limited to the implemented AST nodes and VM-owned built-ins listed above.

The scaffold does not vendor test262. Point it at a local checkout with `TEST262_DIR` or `--test262-dir`; with no filters it runs a small curated subset and reports pass/fail/unsupported results:

```sh
TEST262_DIR=../test262 bun run test262
bun run test262 -- --test262-dir ../test262 test/language/expressions/addition --limit 10
```

The runner enables VM-owned dynamic code for harness setup and uses small local shims for Test262 harness helpers that currently depend on unsupported primordials.

This runner is not part of the normal `bun test` workflow and is intended as lightweight conformance tooling for future pass-list work.

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
