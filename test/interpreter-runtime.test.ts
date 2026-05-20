import { describe, expect, test } from "bun:test";
import { VMError, VMErrorCode, createCapability } from "../src/boundary";
import {
  VMEnvironment,
  createGlobalEnvironment,
  createLexicalEnvironment,
} from "../src/interpreter/environment";
import {
  ExecutionBudget,
  breakCompletion,
  continueCompletion,
  createExecutionContext,
  isAbruptCompletion,
  normalCompletion,
  returnCompletion,
  throwCompletion,
  unwrapNormalCompletion,
} from "../src/interpreter/runtime";
import {
  createHostCallable,
  invokeHostCallable,
  isHostCallable,
  revokeHostCallable,
} from "../src/interpreter/values";

function expectVMError(error: unknown, code: VMErrorCode): VMError {
  expect(error).toBeInstanceOf(VMError);
  expect((error as VMError).code).toBe(code);
  return error as VMError;
}

describe("interpreter environments", () => {
  test("defines, resolves, sets, and deletes bindings through parent scopes", () => {
    const global = createGlobalEnvironment({ answer: 41 });
    const lexical = createLexicalEnvironment(global);

    lexical.define("local", { kind: "let", value: 1 });
    lexical.set("answer", 42);

    expect(lexical.has("answer")).toBe(true);
    expect(lexical.hasOwn("answer")).toBe(false);
    expect(global.get("answer")).toBe(42);
    expect(lexical.get("local")).toBe(1);

    expect(lexical.delete("answer")).toBe(true);
    expect(global.has("answer")).toBe(false);
    expect(lexical.delete("missing")).toBe(true);
  });

  test("reports TDZ, immutable binding, and duplicate binding errors", () => {
    const environment = new VMEnvironment();
    environment.define("beforeInit", { kind: "let", initialized: false });
    environment.define("constant", { kind: "const", value: 1 });

    try {
      environment.get("beforeInit");
      throw new Error("Expected TDZ access to fail.");
    } catch (error) {
      const vmError = expectVMError(error, VMErrorCode.VMRuntimeError);
      expect(vmError.details.reason).toBe("temporal dead zone");
    }

    environment.initialize("beforeInit", 2);
    expect(environment.get("beforeInit")).toBe(2);

    expect(() => environment.set("constant", 3)).toThrow(VMError);
    expect(() => environment.define("constant", { value: 3 })).toThrow(VMError);
    expect(environment.delete("constant")).toBe(false);
  });

  test("stores guest state in null-prototype records", () => {
    const environment = createGlobalEnvironment();
    environment.define("__proto__", { kind: "var", value: "guest value" });
    environment.define("toString", { kind: "var", value: "shadowed" });

    const snapshot = environment.snapshotInitializedBindings();

    expect(environment.get("__proto__")).toBe("guest value");
    expect(environment.get("toString")).toBe("shadowed");
    expect(Object.getPrototypeOf(snapshot)).toBeNull();
    expect(snapshot.__proto__).toBe("guest value");
    expect(Object.prototype).not.toHaveProperty("guest value");
  });

  test("reconstructs initial global bindings and snapshots", () => {
    const hostGlobal = { nested: { value: 1 } };
    const environment = createGlobalEnvironment({ hostGlobal });
    const guestGlobal = environment.get("hostGlobal") as {
      nested: { value: number };
    };

    guestGlobal.nested.value = 2;
    expect(hostGlobal.nested.value).toBe(1);
    expect(Object.getPrototypeOf(guestGlobal)).toBeNull();

    const snapshot = environment.snapshotInitializedBindings();
    (snapshot.hostGlobal as { nested: { value: number } }).nested.value = 3;
    expect(guestGlobal.nested.value).toBe(2);
  });
});

describe("interpreter execution primitives", () => {
  test("creates completion records for evaluator control flow", () => {
    const normal = normalCompletion(1);
    const returned = returnCompletion(2);
    const thrown = throwCompletion("boom");

    expect(unwrapNormalCompletion(normal)).toBe(1);
    expect(isAbruptCompletion(normal)).toBe(false);
    expect(isAbruptCompletion(returned)).toBe(true);
    expect(isAbruptCompletion(breakCompletion("loop"))).toBe(true);
    expect(continueCompletion().type).toBe("continue");
    expect(thrown).toEqual({ type: "throw", value: "boom" });
    expect(() => unwrapNormalCompletion(returned)).toThrow(VMError);
  });

  test("checks cooperative step and time budgets", () => {
    let now = 100;
    const budget = new ExecutionBudget({
      maxSteps: 3,
      timeLimitMs: 10,
      now: () => now,
    });

    budget.checkpoint(2, "binary expression");
    expect(budget.stepsUsed).toBe(2);
    expect(budget.remainingSteps).toBe(1);

    try {
      budget.checkpoint(2, "loop body");
      throw new Error("Expected step budget to fail.");
    } catch (error) {
      const vmError = expectVMError(error, VMErrorCode.VMStepsExceededError);
      expect(vmError.details.path).toBe("maxSteps");
    }

    budget.reset();
    now = 111;

    try {
      budget.checkpoint(1, "time check");
      throw new Error("Expected time limit to fail.");
    } catch (error) {
      const vmError = expectVMError(error, VMErrorCode.VMTimeoutError);
      expect(vmError.details.path).toBe("timeLimitMs");
    }
  });

  test("manages global and lexical environments in an execution context", () => {
    const context = createExecutionContext({ budget: { maxSteps: 2 } });
    context.globalEnvironment.define("globalValue", { kind: "var", value: 1 });

    const block = context.enterLexicalEnvironment();
    block.define("localValue", { kind: "let", value: 2 });

    expect(context.lexicalEnvironment.get("localValue")).toBe(2);
    expect(context.lexicalEnvironment.get("globalValue")).toBe(1);

    context.checkpoint(1);
    expect(context.budget.remainingSteps).toBe(1);
    expect(context.leaveLexicalEnvironment(block)).toBe(
      context.globalEnvironment,
    );
  });
});

describe("interpreter host callable values", () => {
  test("wraps host capabilities without exposing a callable prototype", async () => {
    const observedArgs: unknown[] = [];
    const callable = createHostCallable("mutate", (value) => {
      observedArgs.push(value);
      (value as { nested: { value: number } }).nested.value = 99;
      return { ok: true };
    });
    const guestArg = { nested: { value: 1 } };

    expect(isHostCallable(callable)).toBe(true);
    expect(typeof callable).toBe("object");
    expect(Object.getPrototypeOf(callable)).toBeNull();
    expect(Object.getPrototypeOf(callable.metadata)).toBeNull();
    expect("invoke" in callable).toBe(false);
    expect("constructor" in callable.metadata).toBe(false);
    expect((callable as { prototype?: unknown }).prototype).toBeUndefined();
    expect((callable as { constructor?: unknown }).constructor).toBeUndefined();

    await expect(invokeHostCallable(callable, [guestArg])).resolves.toEqual({
      ok: true,
    });
    expect(guestArg.nested.value).toBe(1);
    expect(Object.getPrototypeOf(observedArgs[0] as object)).toBeNull();
  });

  test("wraps and revokes existing boundary capabilities", async () => {
    const capability = createCapability("answer", () => 42);
    const callable = createHostCallable("answer", capability);

    await expect(invokeHostCallable(callable, [])).resolves.toBe(42);
    revokeHostCallable(callable);
    await expect(invokeHostCallable(callable, [])).rejects.toMatchObject({
      code: VMErrorCode.BoundaryCapabilityRevoked,
    });
  });
});
