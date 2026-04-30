# JSVM vision

JSVM is a TypeScript library for creating secure-by-default JavaScript virtual machines that can run arbitrary, user-generated, or otherwise untrusted JavaScript code.

The library should work in browsers and other standards-based JavaScript hosts without relying on Node.js, Bun, filesystem, process, native module, or server-only APIs. Its core purpose is to give application developers a clear and intentional boundary between their host application and guest JavaScript code.

## What we are building

JSVM provides isolated JavaScript execution environments with explicit host-to-guest and guest-to-host communication. A VM should be able to evaluate JavaScript, maintain its own global scope, expose only the capabilities the host deliberately provides, and return results in a controlled way.

The library is intended for use cases such as:

- Running user-authored plugins, scripts, rules, formulas, or automations.
- Evaluating educational or sandboxed code in browser applications.
- Safely extending applications without granting guest code access to the host environment.
- Building higher-level products that need deterministic, inspectable JavaScript execution.

JSVM is not intended to be a thin wrapper around unsafe host evaluation primitives. Security should come from the VM boundary itself, not from asking users to remember every dangerous edge case. The current implementation follows this by parsing guest source and interpreting supported AST nodes directly, without using host `eval`, indirect `eval`, `Function`, `AsyncFunction`, or dynamic `import()` to execute guest source.

## Core principles

### Secure by default

The default VM configuration must be safe for untrusted code. Users should not need to opt in to basic isolation.

By default, guest code must not have access to:

- Host globals such as `window`, `document`, `globalThis`, `process`, or equivalent host objects.
- Network, filesystem, timers, storage, workers, or other ambient host capabilities.
- Constructors or prototypes that allow escaping into the host environment.
- Host objects unless they were explicitly passed through a controlled boundary.

Unsafe behavior, if ever supported, must require explicit and clearly named opt-in APIs.

### Clear host and guest boundary

The boundary between the host and the VM must be obvious in both implementation and API design.

Guest code should only cross into the host through explicit capabilities, imports, bindings, callbacks, or message-like APIs provided by the host. Host code should only observe or mutate guest state through explicit VM APIs. Values that cross the current host/guest boundary must serialize and reconstruct into fresh values; host functions are represented as capabilities whose arguments and results also serialize and reconstruct.

There must be no accidental boundary crossing through prototype inheritance, shared mutable intrinsics, leaked constructors, getters, symbols, error stacks, host object identity, or implicit global access.

### Capability-based access

Guest code should receive capabilities, not ambient authority.

If a script needs `console.log`, the host should provide a logging capability. If a script needs data, the host should pass that data. If a script needs persistence, fetching, or timing, the host should expose a narrow, auditable interface rather than giving access to the surrounding platform.

Capabilities should be:

- Explicitly named.
- Narrow in scope.
- Easy to review.
- Revocable or replaceable where practical.
- Wrapped or copied so host objects cannot be abused to escape isolation.

### Browser-compatible core

The core library must be compatible with modern browsers.

That means the core cannot depend on:

- Node.js built-ins.
- Bun-specific APIs.
- Native addons.
- Filesystem access.
- Process-level sandboxing.
- Server-only module loading behavior.

Browser compatibility should be treated as a design constraint, not as a later adapter.

### Latest ECMAScript support

JSVM should aim to support the latest ECMAScript standard and remain maintainable as the language evolves.

The architecture should make it realistic to add or update support for:

- New syntax.
- New standard library behavior.
- Updated semantics.
- New built-in objects.
- Future ECMAScript proposals once standardized.

Language support should be tested against clear compatibility expectations rather than being treated as incidental behavior.

## Security necessities

JSVM must treat isolation as a primary product requirement.

The library needs protections against:

- Prototype pollution and prototype jumping.
- Constructor escape patterns such as reaching host `Function`.
- Shared mutable intrinsics between host and guest.
- Access to host globals through `this`, `globalThis`, `eval`, indirect eval, constructors, dynamic import, or reflective APIs.
- Host object leakage through errors, stack traces, callbacks, promises, iterators, accessors, proxies, symbols, or thenables.
- Guest mutation of host-provided values unless explicitly allowed.
- Accidental retention of powerful host references.
- Confused-deputy behavior where a safe-looking capability exposes broader host authority.

The VM should prefer serialization/reconstruction, copying, freezing, and internal representations over directly sharing dangerous host objects. Designs that introduce wrappers or membranes must still avoid shared host/guest object identity and mutable references.

Security-sensitive behavior must be covered by tests and documented clearly.

## Execution necessities

JSVM should provide practical controls for running untrusted code.

The library should support:

- Creating independent VM instances.
- Evaluating scripts in a VM-owned global scope.
- Preserving VM state between evaluations when desired.
- Creating fresh isolated contexts when desired.
- Returning primitive values and structured data safely.
- Explicitly injecting safe globals or capabilities.
- Reporting syntax errors, runtime errors, and boundary violations in a structured way.
- Cleaning up VM resources.

The design must enable management of VMs such as:

- Execution time limits.
- Step limits or instruction budgets.
- Memory-related guardrails.
- Deterministic or controlled scheduling.
- Debugging and tracing hooks.
- Source maps or source location reporting.

Because browsers do not provide reliable synchronous preemption for arbitrary JavaScript, resource limiting must be designed honestly. The library should not claim hard guarantees that cannot be delivered in a browser-only implementation. However, security should be a promise.

## User-facing API goals

The public API should be simple, explicit, and hard to misuse.

A possible direction:

```ts
import { VM, networkRule } from "@catmint-fs/jsvm";

const vm = new VM({
	capabilities: {
		// networking capabilities are controlled in the host, and the VM's fetch and XMLHttpRequest wrappers would make the requests to the host (who makes the actual network request) and enforce the declared rules for allowed hosts, methods, paths, and headers - the VM would serialize fetch/XHR arguments, send them to the host, check them against the rules, and either perform the request and return a serialized response or throw a security error if the request violates the rules. Requests are reconstructed in the VM.
		networkingRules: [
			networkRule("example.com")
				.allow({ methods: ["GET"], paths: ["/api/*", "/home" ] })
				.setHeaders({ "X-API-Key": "secret" }),
			networkRule("another.com")
				.allow() // allow everything to another.com
		],
		executionRules: {
			timeLimit: 1000, // milliseconds of execution time before the VM stops evaluating and throws a timeout error - this would be implemented with cooperative yielding in the VM and a timer in the host, so it would not be a hard guarantee but it would provide a best-effort guardrail against infinite loops or long-running code. Optional, when not set the VM would have no execution time limit.
		},
		numbers: {
			randomSeed: "optional-seed-for-deterministic-randomness" // if provided, the VM's random number generator would produce deterministic results based on the seed, which can be useful for testing or reproducible behavior. If not provided, the VM would use a non-deterministic source of randomness. The random capability would expose a safe interface for generating random values without giving access to host randomness sources or allowing guest code to influence host behavior.
			dateNow: 1697059200000 // if provided, the VM's Date.now() would return this fixed timestamp, which can be useful for testing or controlling time-dependent behavior. If not provided, Date.now() would return the actual current time in milliseconds since the epoch. This allows the host to control the passage of time in the VM without giving guest code access to host timing APIs or allowing it to affect host timers.
		}
	},
	globals: {
		// optional additional globals to mirror in the VM, but not shared with the host - these would be deeply reconstructed in the VM and not provide any access to host objects or intrinsics, so they would be safe to use as a starting point for the global scope if desired
		console: {
			log: (message: string) => {
				// this function runs in the host, so it can do things like log to the host console, but it is passed into the VM as a capability and cannot be used to escape the VM or access host objects - the VM would wrap this function in a way that safely reconstructs arguments and return values across the boundary
				console.log(message);
			},
		}
	},

});

await vm.start(); // required step that initializes the VM.

const resultA = await vm.eval("log('hello from the guest'); 1 + 2");
const resultB = await vm.evalFile("/path/to/script.js");
const resultC = await vm.evalRemote("https://example.com/script.js");

const resultD = await vm.dangerously.import("https://example.com/module.js"); // returns whatever the module exports after evaluating it in the VM

const snapshot = vm.snapshot();
// ... later ...
const vm2 = VM.fromSnapshot(snapshot);

// interfacing
const module = await vm.import("https://example.com/module.js"); // returns a wrapped module namespace object with only the exported values, no access to host globals or intrinsics - any calls into the module are proxied through the VM boundary and results are reconstructed safely after serialization of values
const out = await module.someFunction("hello"); // calls someFunction in the VM, passing "hello" as an argument, and returns a reconstructed result in the host with serialized values crossing the boundary safely

// global extraction
const guestGlobalMain = await vm.getGlobalFunction("main"); // retrieves a global function named "main" from the VM, returning a wrapped function that can be called from the host - when called, it executes the guest's main function in the VM and returns a reconstructed result in the host, with arguments and return values safely crossing the boundary through serialization and wrapping to prevent access to host objects or intrinsics

// wait for microtasks to complete in the VM (e.g. pending promises) - this would be necessary to ensure that all guest code has finished executing before, for example, taking a snapshot or disposing the VM, since the VM's event loop and microtask queue would be managed internally and not directly observable from the host
await vm.idle();

// clean up resources when done
vm.dispose();
```

The final API should be designed together, but it should preserve these ideas:

- `new VM()` should produce an isolated VM instance.
- Safe defaults should require little or no configuration.
- Capabilities should be explicit.
- Evaluation should return structured success or failure information.
- Dangerous options should be visibly named and documented.
- TypeScript types should guide users toward safe usage.

Potential public concepts:

- `VM`: an isolated execution environment.
- `snapshot()` or `reset()`: manage VM state.
- `idle()`: wait for the VM to finish executing pending work.
- `dispose()`: release VM resources.
- `VMError`: structured errors for parse, runtime, security, and resource failures.

## Developer experience goals

JSVM should feel like a normal modern npm library.

The project should provide:

- First-class TypeScript types.
- ESM-first package exports.
- Browser-compatible builds.
- Clear README examples.
- Security documentation.
- Compatibility documentation.
- Tests for public behavior and security boundaries.
- A maintainable internal architecture.

The library should be easy to install, import, tree-shake, test, and bundle in browser applications.

## Non-goals

JSVM should avoid scope creep that weakens the security model.

Initial non-goals:

- Depending on Node.js `vm`, Bun internals, isolated-vm, native addons, or OS sandboxing for the core implementation.
- Providing ambient access to browser APIs by default.
- Claiming perfect browser-enforced CPU or memory isolation when the platform cannot guarantee it.
- Optimizing for maximum execution speed before correctness and isolation are established.

## Maintenance expectations

The implementation should be designed for long-term maintenance.

That means:

- Keep parsing, evaluation, runtime values, intrinsics, and host boundaries separated.
- Isolate ECMAScript-version-specific behavior so it can be updated.
- Prefer small internal modules with focused responsibilities.
- Add conformance-style tests as language support grows.
- Maintain security regression tests for known escape patterns.
- Document intentional limitations.
- Treat dependency choices carefully, especially dependencies involved in parsing or code execution.

## Definition of success

JSVM succeeds when a developer can confidently create a VM, run untrusted JavaScript in it, provide only intentional capabilities, and understand exactly how data crosses the host-guest boundary.

The library should make safe usage straightforward, unsafe usage (limited and) obvious, and future ECMAScript maintenance achievable.

Look at test262, and run it (all of the non-browser/DOM dependant tests) in the VM to validate compatibility. Add tests for security boundaries and capability enforcement. Document any known limitations or edge cases clearly in the README. 
