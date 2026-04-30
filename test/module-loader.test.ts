import { describe, expect, test } from "bun:test";
import {
  VM,
  VMError,
  VMErrorCode,
  createDefaultDenyModuleLoader,
  normalizeModuleLoader,
  type VMNormalizedModuleLoader,
} from "../src/index";

async function expectRejectedVMError(
  promise: Promise<unknown>,
  code: VMErrorCode,
): Promise<VMError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(VMError);
    expect((error as VMError).code).toBe(code);
    return error as VMError;
  }

  throw new Error(`Expected VMError ${code}.`);
}

describe("module loader", () => {
  test("default-denies module resolution and source loading", async () => {
    const loader = createDefaultDenyModuleLoader();

    expect(Object.isFrozen(loader)).toBe(true);

    const resolveError = await expectRejectedVMError(
      loader.resolve({ specifier: "./dep.js" }),
      VMErrorCode.VMSecurityError,
    );
    expect(resolveError.details).toMatchObject({
      path: "./dep.js",
      reason: "module loader denied",
    });

    const loadError = await expectRejectedVMError(
      loader.load({ specifier: "./dep.js" }),
      VMErrorCode.VMSecurityError,
    );
    expect(loadError.details).toMatchObject({
      path: "./dep.js",
      reason: "module loader denied",
    });
  });

  test("normalizes requests and loader responses into frozen plain data", async () => {
    let observedResolveRequest: unknown;
    let observedLoadRequest: unknown;
    const loader = normalizeModuleLoader({
      resolve(request) {
        observedResolveRequest = request;
        return {
          specifier: "/virtual/dep.js",
          referrer: request.referrer,
          attributes: {
            kind: "static",
            list: [1, undefined, "ok"],
          },
        };
      },
      load(request) {
        observedLoadRequest = request;
        return {
          source: "export const value = 1;",
          attributes: {
            nested: { ok: true },
          },
        };
      },
    });

    const resolution = await loader.resolve({
      specifier: "./dep.js",
      referrer: "main.js",
      attributes: { purpose: "test" },
    });
    const source = await loader.load({
      specifier: resolution.specifier,
      attributes: resolution.attributes,
    });

    expect(Object.isFrozen(observedResolveRequest as object)).toBe(true);
    expect(Object.getPrototypeOf(observedResolveRequest as object)).toBeNull();
    expect(Object.isFrozen(observedLoadRequest as object)).toBe(true);
    expect(Object.getPrototypeOf(observedLoadRequest as object)).toBeNull();

    expect(resolution.type).toBe("module-resolution");
    expect(resolution.specifier).toBe("/virtual/dep.js");
    expect(resolution.referrer).toBe("main.js");
    expect(resolution.attributes).toEqual({
      kind: "static",
      list: [1, undefined, "ok"],
    });
    expect(Object.isFrozen(resolution)).toBe(true);
    expect(Object.isFrozen(resolution.attributes as object)).toBe(true);
    expect(Object.isFrozen((resolution.attributes as { list: unknown[] }).list)).toBe(true);

    expect(source).toMatchObject({
      type: "module-source",
      specifier: "/virtual/dep.js",
      source: "export const value = 1;",
      sourceType: "module",
    });
    expect(source.attributes).toEqual({ nested: { ok: true } });
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(source.attributes as object)).toBe(true);
  });

  test("rejects invalid loader declarations, requests, and callback results", async () => {
    expect(() =>
      normalizeModuleLoader({ resolve: "not a function" as never }),
    ).toThrow(VMError);
    expect(() =>
      normalizeModuleLoader({ resolve: () => "./x.js", ambient: true } as never),
    ).toThrow(VMError);

    const missingResolve = normalizeModuleLoader({});
    await expectRejectedVMError(
      missingResolve.resolve({ specifier: "./x.js" }),
      VMErrorCode.VMSecurityError,
    );

    await expectRejectedVMError(
      missingResolve.resolve({ specifier: "" }),
      VMErrorCode.BoundaryUnsupportedType,
    );

    const badResolution = normalizeModuleLoader({
      resolve: () => ({ specifier: " ./x.js " }),
    });
    await expectRejectedVMError(
      badResolution.resolve({ specifier: "./x.js" }),
      VMErrorCode.BoundaryUnsupportedType,
    );

    const badSource = normalizeModuleLoader({
      load: () => ({ source: () => "export {}" }) as never,
    });
    await expectRejectedVMError(
      badSource.load({ specifier: "./x.js" }),
      VMErrorCode.BoundaryUnsupportedType,
    );

    const badMetadata = normalizeModuleLoader({
      load: () => ({ source: "export {};", attributes: { live: new Date() } }) as never,
    });
    await expectRejectedVMError(
      badMetadata.load({ specifier: "./x.js" }),
      VMErrorCode.BoundaryUnsupportedType,
    );
  });

  test("VM module evaluation is explicit and default-denies dependency resolution", async () => {
    const vm = new VM();
    await vm.start();

    const denied = await vm.evaluate("import value from './dep.js'; value;", {
      sourceType: "module",
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.code).toBe(VMErrorCode.VMSecurityError);
      expect(denied.error.details).toMatchObject({
        path: "./dep.js",
        reason: "module loader denied",
      });
    }

    const exportOnly = await vm.evaluate("export const value = 1;", {
      sourceType: "module",
    });
    expect(exportOnly.ok).toBe(true);
    if (exportOnly.ok) {
      expect(exportOnly.value).toEqual({ value: 1 });
    }
  });

  test("VM resolves and loads dependencies only through the explicit loader", async () => {
    const resolvedSpecifiers: string[] = [];
    const loadedSpecifiers: string[] = [];
    const moduleLoader: VMNormalizedModuleLoader = normalizeModuleLoader({
      resolve(request) {
        resolvedSpecifiers.push(request.specifier);
        return request.specifier;
      },
      load(request) {
        loadedSpecifiers.push(request.specifier);
        return "export const value = 1;";
      },
    });
    const vm = new VM({ capabilities: { moduleLoader } });
    await vm.start();

    const result = await vm.evaluate("import './dep.js';", {
      sourceType: "module",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({});
    }
    expect(resolvedSpecifiers).toEqual(["./dep.js"]);
    expect(loadedSpecifiers).toEqual(["./dep.js"]);
  });

  test("VM evaluates named, default, namespace imports, and re-exports", async () => {
    const sources = new Map([
      [
        "dep",
        `
          const hidden = 40;
          export const named = hidden + 1;
          export default named + 1;
        `,
      ],
      ["barrel", "export { named as renamed, default } from 'dep';"],
    ]);
    const moduleLoader = normalizeModuleLoader({
      resolve: ({ specifier }) => specifier,
      load: ({ specifier }) => sources.get(specifier) ?? "export {};",
    });
    const vm = new VM({ capabilities: { moduleLoader } });
    await vm.start();

    const result = await vm.evaluate(
      `
        import defaultValue, { renamed } from 'barrel';
        import * as ns from 'dep';
        export { renamed };
        export const combined = defaultValue + renamed + ns.named;
      `,
      { sourceType: "module" },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ combined: 124, renamed: 41 });
    }
  });

  test("VM supports export star and keeps module namespace read-only", async () => {
    const moduleLoader = normalizeModuleLoader({
      resolve: ({ specifier }) => specifier,
      load: ({ specifier }) => {
        if (specifier === "dep") {
          return "export const value = 7; export default 9;";
        }
        return "export * from 'dep'; export * as depNS from 'dep';";
      },
    });
    const vm = new VM({ capabilities: { moduleLoader } });
    await vm.start();

    const result = await vm.evaluate(
      `
        import * as ns from 'barrel';
        ns.value = 100;
        export const value = ns.value;
        export const nested = ns.depNS.value;
      `,
      { sourceType: "module" },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ nested: 7, value: 7 });
    }
  });

  test("VM imports modules as opaque host RPC handles", async () => {
    const loads: string[] = [];
    const moduleLoader = normalizeModuleLoader({
      resolve: ({ specifier }) => specifier,
      load: ({ specifier }) => {
        loads.push(specifier);
        return `
          export const value = 3;
          export function add(a, b) {
            return { sum: a + b + value };
          }
          export function fail() {
            throw 'boom';
          }
        `;
      },
    });
    const vm = new VM({ capabilities: { moduleLoader } });
    await vm.start();

    const imported = await vm.import("math");
    expect(imported.ok).toBe(true);
    if (!imported.ok) {
      throw new Error("Expected module handle.");
    }

    expect(imported.value.specifier).toBe("math");
    expect(imported.value.exports()).toEqual(["add", "fail", "value"]);
    expect(await imported.value.get("value")).toEqual({ ok: true, value: 3 });
    expect(await imported.value.call("add", 2, 4)).toEqual({
      ok: true,
      value: { sum: 9 },
    });

    const add = imported.value.getFunction("add");
    expect(add.ok).toBe(true);
    if (!add.ok) {
      throw new Error("Expected function export handle.");
    }
    expect(await add.value.call(1, 2)).toEqual({
      ok: true,
      value: { sum: 6 },
    });

    expect(imported.value.getFunction("value").ok).toBe(false);
    const failed = await imported.value.call("fail");
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.code).toBe(VMErrorCode.VMRuntimeError);
    }

    const importedAgain = await vm.import("math");
    expect(importedAgain.ok).toBe(true);
    expect(loads).toEqual(["math"]);

    vm.reset();
    const stale = await add.value.call(1, 2);
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe(VMErrorCode.VMRuntimeError);
      expect(stale.error.details.reason).toBe("stale handle");
    }
  });

  test("VM keeps module locals isolated from the global scope", async () => {
    const vm = new VM();
    await vm.start();

    const moduleResult = await vm.evaluate(
      "const secret = 1; export const visible = secret + 1;",
      { sourceType: "module" },
    );
    expect(moduleResult.ok).toBe(true);
    if (moduleResult.ok) {
      expect(moduleResult.value).toEqual({ visible: 2 });
    }

    const globalRead = await vm.evaluate("secret");
    expect(globalRead.ok).toBe(false);
    if (!globalRead.ok) {
      expect(globalRead.error.code).toBe(VMErrorCode.VMRuntimeError);
      expect(globalRead.error.details.reason).toBe("missing binding");
    }
  });

  test("VM reports module loader, missing export, module throw, and cycle failures", async () => {
    const deniedLoader = normalizeModuleLoader({
      resolve: ({ specifier }) => specifier,
    });
    const deniedVM = new VM({ capabilities: { moduleLoader: deniedLoader } });
    await deniedVM.start();
    const denied = await deniedVM.evaluate("import 'dep';", { sourceType: "module" });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.code).toBe(VMErrorCode.VMSecurityError);
      expect(denied.error.details.reason).toBe("module loader denied");
    }

    const missingExportVM = new VM({
      capabilities: {
        moduleLoader: normalizeModuleLoader({
          resolve: ({ specifier }) => specifier,
          load: () => "export const other = 1;",
        }),
      },
    });
    await missingExportVM.start();
    const missing = await missingExportVM.evaluate("import { value } from 'dep';", {
      sourceType: "module",
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe(VMErrorCode.VMRuntimeError);
      expect(missing.error.details.reason).toBe("missing module export");
    }

    const throwingVM = new VM({
      capabilities: {
        moduleLoader: normalizeModuleLoader({
          resolve: ({ specifier }) => specifier,
          load: () => "throw 'boom'; export const value = 1;",
        }),
      },
    });
    await throwingVM.start();
    const thrown = await throwingVM.evaluate("import { value } from 'dep';", {
      sourceType: "module",
    });
    expect(thrown.ok).toBe(false);
    if (!thrown.ok) {
      expect(thrown.error.code).toBe(VMErrorCode.VMRuntimeError);
      expect(thrown.error.details.reason).toBe("throw completion");
    }

    const cycleVM = new VM({
      capabilities: {
        moduleLoader: normalizeModuleLoader({
          resolve: ({ specifier }) => specifier,
          load: ({ specifier }) =>
            specifier === "a"
              ? "import 'b'; export const a = 1;"
              : "import 'a'; export const b = 1;",
        }),
      },
    });
    await cycleVM.start();
    const cycle = await cycleVM.evaluate("import 'a';", { sourceType: "module" });
    expect(cycle.ok).toBe(false);
    if (!cycle.ok) {
      expect(cycle.error.code).toBe(VMErrorCode.VMRuntimeError);
      expect(cycle.error.details.reason).toBe("module cycle unsupported");
    }
  });
});
