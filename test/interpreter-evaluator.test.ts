import { describe, expect, test } from "bun:test";
import { VMError, VMErrorCode } from "../src/boundary";
import {
  createEvaluatorContext,
  evaluateSource,
} from "../src/interpreter/evaluator";
import { createHostCallable } from "../src/interpreter/values";

function expectVMError(error: unknown, code: VMErrorCode): VMError {
  expect(error).toBeInstanceOf(VMError);
  expect((error as VMError).code).toBe(code);
  return error as VMError;
}

describe("interpreter evaluator", () => {
  test("evaluates expressions, declarations, assignments, and persisted globals", async () => {
    const context = createEvaluatorContext();

    await expect(evaluateSource("counter = 1; counter + 2", { context })).resolves.toBe(3);
    await expect(evaluateSource("counter += 4; counter", { context })).resolves.toBe(5);
    await expect(evaluateSource("let local = counter + 1; local", { context })).resolves.toBe(6);
    await expect(evaluateSource("local", { context })).resolves.toBe(6);
  });

  test("runs control flow with cooperative budget checks", async () => {
    const context = createEvaluatorContext({ budget: { maxSteps: 200 } });

    await expect(evaluateSource(`
      let total = 0;
      for (let i = 0; i < 6; i++) {
        if (i === 3) continue;
        total += i;
      }
      while (total < 20) {
        total++;
        if (total === 18) break;
      }
      total;
    `, { context })).resolves.toBe(18);

    await expect(
      evaluateSource("while (true) {}", {
        context: createEvaluatorContext({ budget: { maxSteps: 20 } }),
      }),
    ).rejects.toMatchObject({ code: VMErrorCode.VMTimeoutError });
  });

  test("supports guest functions and arrow functions", async () => {
    await expect(evaluateSource(`
      function add(a, b) { return a + b; }
      const double = (value) => value * 2;
      add(2, 3) + double(4);
    `)).resolves.toBe(13);
  });

  test("calls host capabilities through cloned boundary values", async () => {
    const observedArgs: unknown[] = [];
    const hostResult = { nested: { value: 10 } };
    const context = createEvaluatorContext({
      globals: {
        host: {
          mutateAndReturn: createHostCallable("mutateAndReturn", (value) => {
            observedArgs.push(value);
            (value as { nested: { value: number } }).nested.value = 99;
            return hostResult;
          }),
        },
      },
    });

    await expect(evaluateSource(`
      (async () => {
        let guestArg = { nested: { value: 1 } };
        let guestResult = await host.mutateAndReturn(guestArg);
        guestResult.nested.value = 11;
        return [guestArg.nested.value, guestResult.nested.value];
      })();
    `, { context })).resolves.toEqual([1, 11]);

    expect((observedArgs[0] as { nested: { value: number } }).nested.value).toBe(99);
    expect(hostResult.nested.value).toBe(10);
  });

  test("imports host globals as reconstructed guest copies", async () => {
    const hostGlobal = { nested: { value: 1 } };
    const context = createEvaluatorContext({
      globals: {
        hostGlobal,
      },
    });

    await expect(evaluateSource("hostGlobal.nested.value = 2; hostGlobal.nested.value", {
      context,
    })).resolves.toBe(2);

    expect(hostGlobal.nested.value).toBe(1);
    await expect(evaluateSource("hostGlobal.nested.value", { context })).resolves.toBe(2);
  });

  test("exports evaluator results as reconstructed host copies", async () => {
    const context = createEvaluatorContext();
    const result = await evaluateSource("guestState = { nested: { value: 1 } }; guestState", {
      context,
    });

    (result as { nested: { value: number } }).nested.value = 99;

    await expect(evaluateSource("guestState.nested.value", { context })).resolves.toBe(1);
  });

  test("keeps host escapes absent while allowing VM-owned reserved-looking keys", async () => {
    await expect(evaluateSource("({}).constructor")).resolves.toBeUndefined();
    await expect(evaluateSource("({}).__proto__")).resolves.toBeUndefined();
    await expect(evaluateSource("({ constructor: 1, __proto__: 2, prototype: 3 }).constructor")).resolves.toBe(1);
    await expect(evaluateSource("Function('return this')")).rejects.toMatchObject({
      code: VMErrorCode.VMRuntimeError,
    });
    await expect(evaluateSource("eval('1 + 1')")).rejects.toMatchObject({
      code: VMErrorCode.VMRuntimeError,
    });
    await expect(evaluateSource("process")).rejects.toMatchObject({
      code: VMErrorCode.VMRuntimeError,
    });
    await expect(evaluateSource("typeof process")).resolves.toBe("undefined");

    try {
      await evaluateSource("this");
      throw new Error("Expected this to fail.");
    } catch (error) {
      expectVMError(error, VMErrorCode.VMSecurityError);
    }
  });

  test("returns cloned serializable values and rejects callable exports", async () => {
    const value = await evaluateSource("({ nested: { value: 1 }, list: [1, 2] })");

    expect(Object.getPrototypeOf(value as object)).toBeNull();
    expect(value).toEqual({ nested: { value: 1 }, list: [1, 2] });

    await expect(evaluateSource("() => 1")).rejects.toMatchObject({
      code: VMErrorCode.BoundaryUnsupportedType,
    });
  });

  test("fails unsupported syntax with structured VM errors", async () => {
    try {
      await evaluateSource("class A {} A;");
      throw new Error("Expected class syntax to be unsupported.");
    } catch (error) {
      const vmError = expectVMError(error, VMErrorCode.VMRuntimeError);
      expect(vmError.details.reason).toBe("unsupported syntax");
    }
  });
});
