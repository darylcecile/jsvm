import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  VM,
  VMError,
  VMErrorCode,
  networkRule,
  type VMResult,
} from "../src/index";

function expectVMFailure(result: VMResult, code: VMErrorCode): VMError {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error(`Expected VM failure ${code}, got success.`);
  }

  expect(result.error).toBeInstanceOf(VMError);
  expect(result.error.code).toBe(code);
  return result.error;
}

function expectThrownVMError(error: unknown, code: VMErrorCode): VMError {
  expect(error).toBeInstanceOf(VMError);
  expect((error as VMError).code).toBe(code);
  return error as VMError;
}

const srcDirectory = join(import.meta.dir, "../src");

function listSourceFiles(directory = srcDirectory): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...listSourceFiles(path));
    } else if (entry.isFile() && path.endsWith(".ts")) {
      files.push(path);
    }
  }

  return files;
}

describe("VM", () => {
  test("does not contain host eval or function-constructor execution sinks in src", () => {
    const unsafeMatches: string[] = [];
    const unsafePatterns = [
      {
        name: "Function constructor",
        pattern: /\b(?:new\s+)?Function\s*\(/,
      },
      {
        name: "AsyncFunction constructor",
        pattern: /\b(?:new\s+)?AsyncFunction\s*\(/,
      },
      {
        name: "direct eval",
        pattern: /(^|[^\w$.])eval\s*\(/,
      },
      {
        name: "indirect eval",
        pattern: /\(\s*0\s*,\s*eval\s*\)\s*\(/,
      },
      {
        name: "dynamic import",
        pattern: /\bimport\s*\(/,
      },
    ];

    for (const file of listSourceFiles()) {
      const relativeFile = relative(srcDirectory, file);
      const lines = readFileSync(file, "utf8").split(/\r?\n/);

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];

        for (const { name, pattern } of unsafePatterns) {
          if (name === "direct eval" && /\basync\s+eval\s*\(/.test(line)) {
            continue;
          }

          if (pattern.test(line)) {
            unsafeMatches.push(`${relativeFile}:${index + 1}: ${name}: ${line.trim()}`);
          }
        }
      }
    }

    expect(unsafeMatches).toEqual([]);
  });

  test("evaluates public VM source through the interpreter without host eval or Function", async () => {
    const marker = "__vmjsHostExecutionCanary";
    const hostGlobal = globalThis as typeof globalThis & {
      [marker]?: unknown;
      Function: FunctionConstructor;
      eval: typeof eval;
    };
    const originalFunction = hostGlobal.Function;
    const originalEval = hostGlobal.eval;
    let functionCalls = 0;
    let evalCalls = 0;

    delete hostGlobal[marker];
    Object.defineProperty(hostGlobal, "Function", {
      configurable: true,
      writable: true,
      value: function blockedFunctionConstructor() {
        functionCalls += 1;
        throw new Error("host Function constructor was used");
      },
    });
    Object.defineProperty(hostGlobal, "eval", {
      configurable: true,
      writable: true,
      value: function blockedEval() {
        evalCalls += 1;
        throw new Error("host eval was used");
      },
    });

    try {
      const vm = new VM();
      await vm.start();

      expect(await vm.eval("const add = (a, b) => a + b; add(2, 3);")).toEqual({
        ok: true,
        value: 5,
      });
      expect(functionCalls).toBe(0);
      expect(evalCalls).toBe(0);

      expectVMFailure(
        await vm.eval(`globalThis.${marker} = true; 1;`),
        VMErrorCode.VMRuntimeError,
      );
      expect(hostGlobal[marker]).toBeUndefined();
    } finally {
      Object.defineProperty(hostGlobal, "Function", {
        configurable: true,
        writable: true,
        value: originalFunction,
      });
      Object.defineProperty(hostGlobal, "eval", {
        configurable: true,
        writable: true,
        value: originalEval,
      });
      delete hostGlobal[marker];
    }
  });

  test("evaluates code and preserves explicit global assignments", async () => {
    const vm = new VM();
    await vm.start();

    expect(await vm.eval("counter = 1; counter + 2")).toEqual({
      ok: true,
      value: 3,
    });
    expect(await vm.evaluate("counter += 4; counter")).toEqual({
      ok: true,
      value: 5,
    });
    expect(await vm.eval("let declaredCounter = counter + 1; declaredCounter")).toEqual({
      ok: true,
      value: 6,
    });
    expect(await vm.eval("declaredCounter")).toEqual({
      ok: true,
      value: 6,
    });
  });

  test("keeps default host globals unavailable and default-denies networking", async () => {
    const vm = new VM();
    await vm.start();

    expect(await vm.eval("typeof window")).toEqual({
      ok: true,
      value: "undefined",
    });
    expect(await vm.eval("typeof process")).toEqual({
      ok: true,
      value: "undefined",
    });

    const result = await vm.eval("fetch('https://example.com')");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(VMErrorCode.VMSecurityError);
    }
  });

  test("isolates host globals from the default guest scope", async () => {
    const vm = new VM();
    await vm.start();

    expect(
      await vm.eval(`[
        typeof window,
        typeof document,
        typeof process,
        typeof fetch,
        typeof globalThis,
        typeof self,
        typeof top,
        typeof parent
      ]`),
    ).toEqual({
      ok: true,
      value: [
        "undefined",
        "undefined",
        "undefined",
        "function",
        "undefined",
        "undefined",
        "undefined",
        "undefined",
      ],
    });

    for (const source of [
      "window.location",
      "document.body",
      "process.version",
      "globalThis.process",
      "self.fetch",
      "top.document",
      "parent.window",
    ]) {
      expectVMFailure(await vm.eval(source), VMErrorCode.VMRuntimeError);
    }

    expectVMFailure(
      await vm.eval("fetch('https://example.com')"),
      VMErrorCode.VMSecurityError,
    );

    expect(await vm.eval("typeof XMLHttpRequest")).toEqual({
      ok: true,
      value: "function",
    });
  });

  test("treats constructor-like names as VM data without exposing host objects", async () => {
    const hostGlobal = globalThis as typeof globalThis & {
      vmjsEscapedFromTest?: unknown;
    };
    const vm = new VM();
    await vm.start();
    delete hostGlobal.vmjsEscapedFromTest;

    try {
      expect(await vm.eval(`
        constructor = 1;
        __proto__ = 2;
        prototype = 3;
        const object = { constructor: 4, __proto__: 5, prototype: 6 };
        [
          constructor,
          __proto__,
          prototype,
          object.constructor,
          object.__proto__,
          object.prototype,
          ({}).constructor,
          ({}).__proto__,
          ({}).prototype
        ];
      `)).toEqual({
        ok: true,
        value: [1, 2, 3, 4, 5, 6, undefined, undefined, undefined],
      });

      for (const source of [
        "window",
        "document",
        "process",
        "globalThis",
        "self",
        "top",
        "parent",
        "globalThis.process",
        "globalThis['fetch']",
        "({}).constructor.constructor('return this')()",
        "Function('return this')()",
        "AsyncFunction('return this')()",
        "JSON.parse.constructor",
        "fetch.constructor",
        "window['constructor']",
        "Object.getPrototypeOf({})",
        "Object.setPrototypeOf({}, null)",
        "Object.getOwnPropertyNames({})",
        "Reflect.get({}, 'x')",
        "new Proxy({}, {})",
        "eval('1 + 1')",
        "(0, eval)('1 + 1')",
        "([]).filter[\"constr\" + \"uctor\"](\"return pro\" + \"cess.version\")()",
        "([]).filter[`constr` + `uctor`](\"return global\" + \"This\")()",
        "({}).toString[\"constr\\u0075\" + \"ctor\"](\"return pro\" + \"cess\")()",
        "([]).filter[\"constr\" + \"uctor\"](\"global\" + \"This.vmjsEscapedFromTest = 1; return 0\")()",
      ]) {
        expectVMFailure(await vm.eval(source), VMErrorCode.VMRuntimeError);
      }

      expectVMFailure(
        await vm.eval("import('data:text/javascript,export default 1')"),
        VMErrorCode.VMSecurityError,
      );

      for (const source of ["Object.constructor", "Math.constructor", "Date.constructor"]) {
        expect(await vm.eval(source)).toEqual({
          ok: true,
          value: undefined,
        });
      }

      expectVMFailure(await vm.eval("this"), VMErrorCode.VMSecurityError);
      expect(hostGlobal.vmjsEscapedFromTest).toBeUndefined();
    } finally {
      delete hostGlobal.vmjsEscapedFromTest;
    }
  });

  test("wraps callable globals across the boundary", async () => {
    const messages: string[] = [];
    const vm = new VM({
      globals: {
        console: {
          log(message) {
            messages.push(String(message));
            return undefined;
          },
        },
      },
    });
    await vm.start();

    expect(await vm.eval("console.log('hello from guest'); 42")).toEqual({
      ok: true,
      value: 42,
    });
    expect(messages).toEqual(["hello from guest"]);
  });

  test("enforces explicit capabilities and clones capability arguments and results", async () => {
    const observedArgs: unknown[] = [];
    const hostResult = { nested: { value: 10 } };
    const vm = new VM({
      globals: {
        answer: 42,
        host: {
          mutateAndReturn(value) {
            observedArgs.push(value);
            (value as { nested: { value: number } }).nested.value = 99;
            return hostResult;
          },
        },
      },
    });
    await vm.start();

    expect(await vm.eval("typeof secret")).toEqual({
      ok: true,
      value: "undefined",
    });
    expect(
      await vm.eval(`
        (async () => {
          guestArg = { nested: { value: 1 } };
          const guestResult = await host.mutateAndReturn(guestArg);
          guestResult.nested.value = 11;
          return [answer, guestArg.nested.value, guestResult.nested.value];
        })()
      `),
    ).toEqual({
      ok: true,
      value: [42, 1, 11],
    });
    expect((observedArgs[0] as { nested: { value: number } }).nested.value).toBe(99);
    expect(hostResult.nested.value).toBe(10);
  });

  test("uses serialization-only copies for capability arguments and results", async () => {
    let observedArg: { nested: { value: number } } | undefined;
    const vm = new VM({
      globals: {
        host: {
          echo(value) {
            observedArg = value as { nested: { value: number } };
            observedArg.nested.value = 7;
            return value;
          },
        },
      },
    });
    await vm.start();

    const result = await vm.eval(`
      (async () => {
        guestArg = { nested: { value: 1 } };
        const echoed = await host.echo(guestArg);
        echoed.nested.value = 2;
        return [guestArg.nested.value, echoed.nested.value];
      })()
    `);

    expect(result).toEqual({
      ok: true,
      value: [1, 2],
    });
    expect(observedArg).toBeDefined();
    expect(observedArg?.nested.value).toBe(7);
    expect(Object.getPrototypeOf(observedArg as object)).toBeNull();
  });

  test("returns structured boundary errors for unsupported values crossing capabilities", async () => {
    const invalidGlobal = new VM({
      globals: {
        unsafe: Symbol("host symbol") as never,
      },
    });
    await expect(invalidGlobal.start()).rejects.toMatchObject({
      code: VMErrorCode.BoundaryUnsupportedType,
    });

    const invalidReturn = new VM({
      globals: {
        leak: () => Symbol("guest visible") as never,
      },
    });
    await invalidReturn.start();

    const result = await invalidReturn.eval("(async () => await leak())()");
    const error = expectVMFailure(result, VMErrorCode.BoundaryUnsupportedType);
    expect(error.details.path).toBe("$");
    expect(error.details.reason).toContain("Symbols cannot cross");
  });

  test("clones injected globals instead of sharing host objects", async () => {
    const hostData = { nested: { value: 1 } };
    const vm = new VM({ globals: { data: hostData } });
    await vm.start();

    expect(await vm.eval("data.nested.value = 2; data")).toEqual({
      ok: true,
      value: {
        nested: {
          value: 2,
        },
      },
    });
    expect(hostData.nested.value).toBe(1);
  });

  test("keeps injected globals isolated from later host and guest mutations", async () => {
    const hostData = {
      nested: { value: 1 },
      list: [1, 2],
    };
    const vm = new VM({ globals: { data: hostData } });
    await vm.start();

    expect(
      await vm.eval(`
        data.nested.value = 2;
        data.list[0] = 99;
        data.extra = { guest: true };
        data;
      `),
    ).toEqual({
      ok: true,
      value: {
        nested: { value: 2 },
        list: [99, 2],
        extra: { guest: true },
      },
    });
    expect(hostData).toEqual({
      nested: { value: 1 },
      list: [1, 2],
    });

    hostData.nested.value = 42;
    hostData.list[1] = 77;

    expect(await vm.eval("[data.nested.value, data.list[1]]")).toEqual({
      ok: true,
      value: [2, 2],
    });
  });

  test("returns VM results as reconstructed host copies", async () => {
    const vm = new VM();
    await vm.start();

    const result = await vm.eval("state = { nested: { value: 1 } }; state");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Expected VM result to succeed.");
    }

    (result.value as { nested: { value: number } }).nested.value = 99;

    expect(await vm.eval("state.nested.value")).toEqual({
      ok: true,
      value: 1,
    });
  });

  test("rejects function references crossing the public VM boundary", async () => {
    let observed = false;
    const vm = new VM({
      globals: {
        observe(value) {
          observed = true;
          return value;
        },
        leakFunction() {
          return (() => 1) as never;
        },
      },
    });
    await vm.start();

    expectVMFailure(await vm.eval("() => 1"), VMErrorCode.BoundaryUnsupportedType);
    expectVMFailure(
      await vm.eval("({ fn: function guestFunction() { return 1; } })"),
      VMErrorCode.BoundaryUnsupportedType,
    );
    expectVMFailure(
      await vm.eval("observe(() => 1)"),
      VMErrorCode.BoundaryUnsupportedType,
    );
    expect(observed).toBe(false);
    expectVMFailure(await vm.eval("leakFunction()"), VMErrorCode.BoundaryUnsupportedType);
  });

  test("uses deterministic number controls", async () => {
    const vmA = new VM({
      capabilities: {
        numbers: {
          randomSeed: "seed",
          dateNow: 1_697_059_200_000,
        },
      },
    });
    const vmB = new VM({
      capabilities: {
        numbers: {
          randomSeed: "seed",
          dateNow: 1_697_059_200_000,
        },
      },
    });
    await vmA.start();
    await vmB.start();

    const source = "[Math.random(), Math.random(), Date.now()]";
    expect(await vmA.eval(source)).toEqual(await vmB.eval(source));
    expect(await vmA.eval("Date.now()")).toEqual({
      ok: true,
      value: 1_697_059_200_000,
    });
  });

  test("resets deterministic Math.random and Date.now controls", async () => {
    const vm = new VM({
      capabilities: {
        numbers: {
          randomSeed: "repeatable",
          dateNow: 123_456,
        },
      },
    });
    await vm.start();

    const source = "[Math.random(), Math.random(), Date.now()]";
    const first = await vm.eval(source);
    await vm.eval("guestState = 'cleared by reset'");
    vm.reset();

    expect(await vm.eval(source)).toEqual(first);
    expect(await vm.eval("typeof guestState")).toEqual({
      ok: true,
      value: "undefined",
    });
  });

  test("supports basic serializable snapshots", async () => {
    const vm = new VM({
      capabilities: {
        numbers: {
          randomSeed: "snapshot-seed",
          dateNow: 10,
        },
      },
    });
    await vm.start();
    await vm.eval("answer = { value: 42 }");

    const restored = VM.fromSnapshot(vm.snapshot());

    expect(await restored.eval("answer.value")).toEqual({
      ok: true,
      value: 42,
    });
    expect(await restored.eval("Date.now()")).toEqual({
      ok: true,
      value: 10,
    });
  });

  test("snapshots clone serializable state and reject host capabilities", async () => {
    const vm = new VM();
    await vm.start();
    await vm.eval("state = { nested: { value: 1 } }");

    const snapshot = vm.snapshot();
    await vm.eval("state.nested.value = 2");
    const restored = VM.fromSnapshot(snapshot);

    expect(await restored.eval("state.nested.value")).toEqual({
      ok: true,
      value: 1,
    });

    const capabilityVM = new VM({
      globals: {
        ping: () => "pong",
      },
    });
    await capabilityVM.start();

    try {
      capabilityVM.snapshot();
      throw new Error("Expected snapshot with host capability to fail.");
    } catch (error) {
      expectThrownVMError(error, VMErrorCode.VMSnapshotUnsupported);
    }

    const guestCallableVM = new VM();
    await guestCallableVM.start();
    await guestCallableVM.eval("guestFunction = () => 1");

    try {
      guestCallableVM.snapshot();
      throw new Error("Expected snapshot with guest callable to fail.");
    } catch (error) {
      expectThrownVMError(error, VMErrorCode.VMSnapshotUnsupported);
    }
  });

  test("disposal revokes VM operations", async () => {
    const vm = new VM();
    await vm.start();
    await vm.eval("value = 1");
    vm.dispose();

    await expect(vm.eval("value")).rejects.toMatchObject({
      code: VMErrorCode.VMDisposed,
    });
    await expect(vm.idle()).rejects.toMatchObject({
      code: VMErrorCode.VMDisposed,
    });
    await expect(vm.start()).rejects.toMatchObject({
      code: VMErrorCode.VMDisposed,
    });

    for (const operation of [() => vm.reset(), () => vm.snapshot()]) {
      try {
        operation();
        throw new Error("Expected disposed VM operation to fail.");
      } catch (error) {
        expectThrownVMError(error, VMErrorCode.VMDisposed);
      }
    }
  });

  test("returns structured errors for syntax, runtime, and timeout failures", async () => {
    const vm = new VM({
      capabilities: {
        executionRules: {
          timeLimit: 1,
        },
      },
    });
    await vm.start();

    const syntax = await vm.eval("const =");
    expect(syntax.ok).toBe(false);
    if (!syntax.ok) {
      expect(syntax.error.code).toBe(VMErrorCode.VMSyntaxError);
    }

    const runtime = await vm.eval("({}).constructor.constructor('return this')()");
    expect(runtime.ok).toBe(false);
    if (!runtime.ok) {
      expect(runtime.error.code).toBe(VMErrorCode.VMRuntimeError);
    }

    const timeout = await vm.eval("while (true) {}");
    expect(timeout.ok).toBe(false);
    if (!timeout.ok) {
      expect(timeout.error.code).toBe(VMErrorCode.VMTimeoutError);
    }
  });

  test("returns structured syntax, runtime, and security errors with details", async () => {
    const vm = new VM();
    await vm.start();

    const nonStringSource = await vm.eval(123 as never);
    expectVMFailure(nonStringSource, VMErrorCode.VMSyntaxError);

    const syntax = await vm.eval("const =");
    expectVMFailure(syntax, VMErrorCode.VMSyntaxError);

    const runtime = await vm.eval("throw 'boom'");
    const runtimeError = expectVMFailure(runtime, VMErrorCode.VMRuntimeError);
    expect(runtimeError.details.valueType).toBe("string");

    const security = await vm.eval("this");
    const securityError = expectVMFailure(security, VMErrorCode.VMSecurityError);
    expect(typeof securityError.details.reason).toBe("string");
  });

  test("unsupported public VM syntax fails clearly without host fallback execution", async () => {
    const marker = "__vmjsUnsupportedSyntaxCanary";
    const hostGlobal = globalThis as typeof globalThis & {
      [marker]?: unknown;
    };
    const vm = new VM();
    await vm.start();

    for (const source of [
      "class A {}",
      `try { globalThis.${marker} = 'try'; } catch {}`,
      `switch (1) { case 1: globalThis.${marker} = 'switch'; }`,
      `for (const value of [1]) { globalThis.${marker} = 'for-of'; }`,
    ]) {
      delete hostGlobal[marker];
      const error = expectVMFailure(await vm.eval(source), VMErrorCode.VMRuntimeError);
      expect(error.details.reason).toBe("unsupported syntax");
      expect(hostGlobal[marker]).toBeUndefined();
    }

    delete hostGlobal[marker];
  });

  test("host-mediates fetch with default-deny network rules", async () => {
    const vm = new VM();
    await vm.start();

    expectVMFailure(
      await vm.eval("fetch('https://example.com/api/data')"),
      VMErrorCode.VMSecurityError,
    );
  });

  test("host-mediates fetch with allow rules and serialized responses", async () => {
    const originalFetch = globalThis.fetch;
    const requests: { url: string; method: string; headers: Record<string, string> }[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: { ...(init?.headers as Record<string, string> | undefined) },
      });

      return new Response(JSON.stringify({ ok: true, url: String(input) }), {
        status: 201,
        statusText: "Created",
        headers: {
          "Content-Type": "application/json",
          "X-Reply": "yes",
        },
      });
    }) as typeof fetch;

    try {
      const vm = new VM({
        capabilities: {
          networkingRules: [
            networkRule("example.com")
              .allow({ methods: ["GET"], paths: ["/api/*"] })
              .setHeaders({ "X-API-Key": "secret" }),
          ],
        },
      });
      await vm.start();

      expect(
        await vm.eval(`
          (async () => {
            const response = await fetch('https://example.com/api/data');
            const body = await response.json();
            return [
              response.ok,
              response.status,
              response.statusText,
              response.headers.get('content-type'),
              response.headers.has('x-reply'),
              body.url
            ];
          })()
        `),
      ).toEqual({
        ok: true,
        value: [
          true,
          201,
          "Created",
          "application/json",
          true,
          "https://example.com/api/data",
        ],
      });
      expect(requests).toEqual([
        {
          url: "https://example.com/api/data",
          method: "GET",
          headers: { "X-API-Key": "secret" },
        },
      ]);

      expectVMFailure(
        await vm.eval("fetch('https://example.com/private')"),
        VMErrorCode.VMSecurityError,
      );
      expectVMFailure(
        await vm.eval("fetch('https://example.com/api/data', { method: 'POST' })"),
        VMErrorCode.VMSecurityError,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("host-mediates constructable XMLHttpRequest with relayed events", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () =>
      new Response("xhr body", {
        status: 202,
        statusText: "Accepted",
        headers: {
          "X-Test": "ok",
        },
      })) as unknown as typeof fetch;

    try {
      const vm = new VM({
        capabilities: {
          networkingRules: [
            networkRule("example.com").allow({ methods: ["POST"], paths: ["/xhr"] }),
          ],
        },
      });
      await vm.start();

      expect(
        await vm.eval(`
          (async () => {
            const xhr = new XMLHttpRequest();
            let events = [];
            xhr.onreadystatechange = () => { events[events.length] = 'rs:' + xhr.readyState; };
            xhr.onload = () => { events[events.length] = 'load:' + xhr.status; };
            xhr.onloadend = () => { events[events.length] = 'end'; };
            xhr.open('POST', 'https://example.com/xhr');
            xhr.setRequestHeader('X-Guest', 'yes');
            await xhr.send('payload');
            return [
              xhr.readyState,
              xhr.status,
              xhr.statusText,
              xhr.responseText,
              xhr.getResponseHeader('x-test'),
              events
            ];
          })()
        `),
      ).toEqual({
        ok: true,
        value: [
          4,
          202,
          "Accepted",
          "xhr body",
          "ok",
          ["rs:2", "rs:3", "rs:4", "load:202", "end"],
        ],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("can still override fetch with an explicit host capability", async () => {
    const vm = new VM({
      capabilities: {
        networkingRules: [networkRule("example.com").allow()],
      },
    });
    await vm.start();

    const explicit = new VM({
      globals: {
        fetch(url) {
          return { ok: true, url: String(url) };
        },
      },
    });
    await explicit.start();

    expect(await explicit.eval("fetch('https://example.com/api/data')")).toEqual({
      ok: true,
      value: {
        ok: true,
        url: "https://example.com/api/data",
      },
    });
  });
});
