import { describe, expect, test } from "bun:test";

import { VMError, VMErrorCode } from "../src/boundary";
import { createEvaluatorContext, evaluateSource } from "../src/interpreter/evaluator";
import { createHostCallable } from "../src/interpreter/values";

function expectVMError(error: unknown, code: VMErrorCode): VMError {
  expect(error).toBeInstanceOf(VMError);
  expect((error as VMError).code).toBe(code);
  return error as VMError;
}

describe("interpreter evaluator", () => {
  test("evaluates expressions, declarations, assignments, and persisted globals", async () => {
    const context = createEvaluatorContext();

    await expect(
      evaluateSource("counter = 1; counter + 2", { context }),
    ).resolves.toBe(3);
    await expect(
      evaluateSource("counter += 4; counter", { context }),
    ).resolves.toBe(5);
    await expect(
      evaluateSource("let local = counter + 1; local", { context }),
    ).resolves.toBe(6);
    await expect(evaluateSource("local", { context })).resolves.toBe(6);
  });

  test("runs control flow with cooperative budget checks", async () => {
    const context = createEvaluatorContext({ budget: { maxSteps: 200 } });

    await expect(
      evaluateSource(
        `
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
    `,
        { context },
      ),
    ).resolves.toBe(18);

    await expect(
      evaluateSource("while (true) {}", {
        context: createEvaluatorContext({ budget: { maxSteps: 20 } }),
      }),
    ).rejects.toMatchObject({ code: VMErrorCode.VMStepsExceededError });
  });

  test("supports guest functions and arrow functions", async () => {
    await expect(
      evaluateSource(`
      function add(a, b) { return a + b; }
      const double = (value) => value * 2;
      add(2, 3) + double(4);
    `),
    ).resolves.toBe(13);
  });

  test("supports spread, object methods, and RegExp literals", async () => {
    const regexp = await evaluateSource("/ab+/gi");

    expect(regexp).toBeInstanceOf(RegExp);
    expect((regexp as RegExp).source).toBe("ab+");
    expect((regexp as RegExp).flags).toBe("gi");

    await expect(
      evaluateSource(`
      const values = [0, ...[1, 2], 3];
      const base = { a: 1, b: 2 };
      const tools = { ...base, triple(value) { return value * 3; } };
      tools.triple(values[1] + values[3]) + tools.a + tools.b;
    `),
    ).resolves.toBe(15);
  });

  test("supports guest object getter and setter accessors", async () => {
    await expect(
      evaluateSource(`
      const object = {
        _value: 2,
        get value() { return this._value + 1; },
        set value(next) { this._value = next * 2; },
      };

      const before = object.value;
      object.value = 5;
      ({ before, stored: object._value, after: object.value });
    `),
    ).resolves.toEqual({ before: 3, stored: 10, after: 11 });
  });

  test("invokes enumerable guest getters during evaluator result export", async () => {
    const context = createEvaluatorContext();

    await expect(
      evaluateSource(
        `
      exported = {
        get value() {
          this.count += 1;
          return this.count;
        },
        count: 0,
      };
      exported;
    `,
        { context },
      ),
    ).resolves.toEqual({ value: 1, count: 1 });

    await expect(evaluateSource("exported.count", { context })).resolves.toBe(
      1,
    );
  });

  test("propagates guest getter throws as VM errors", async () => {
    await expect(
      evaluateSource(`
      const object = {
        get value() {
          throw "boom";
        },
      };
      object.value;
    `),
    ).rejects.toMatchObject({ code: VMErrorCode.VMRuntimeError });

    await expect(
      evaluateSource(`
      ({
        get value() {
          throw "export boom";
        },
      });
    `),
    ).rejects.toMatchObject({ code: VMErrorCode.VMRuntimeError });
  });

  test("supports destructuring, default values, rest bindings, and rest parameters", async () => {
    await expect(
      evaluateSource(`
      const source = { a: 1, b: { c: 2 }, d: 3 };
      const { a, missing = 4, b: { c }, ...rest } = source;
      let [first, , third = 30, ...tail] = [10, 20, , 40, 50];
      let restD;
      ({ a: first, d: restD = 0 } = { a: 7 });

      function collect({ x = 1, y: [z, ...innerRest] }, label = "ok", ...extra) {
        return [x, z, innerRest, label, extra];
      }

      let loop = 0;
      for (const [left = 1, right] of [[, 2], [3, 4]]) {
        loop += left + right;
      }

      try {
        throw { payload: [5, 6, 7], skip: true };
      } catch ({ payload: [caught, ...caughtRest] }) {
        loop += caught + caughtRest[1];
      }

      ({ a, missing, c, rest, first, restD, third, tail, collected: collect({ y: [8, 9, 10] }, void 0, "extra"), loop });
    `),
    ).resolves.toEqual({
      a: 1,
      missing: 4,
      c: 2,
      rest: { d: 3 },
      first: 7,
      restD: 0,
      third: 30,
      tail: [40, 50],
      collected: [1, 8, [9, 10], "ok", ["extra"]],
      loop: 22,
    });
  });

  test("supports optional chaining for VM property access and calls", async () => {
    await expect(
      evaluateSource(`
      const none = null;
      let hits = 0;
      const object = {
        nested: {
          value: 3,
          method(value) { return value + 1; },
        },
        missing: null,
      };

      const skippedMember = none?.[hits += 1]?.value;
      const skippedCall = object.missing?.method(hits += 10);
      const skippedOptionalCall = object.nested.nope?.(hits += 100);
      const called = object.nested.method?.(4);

      ({ missing: none?.value, skippedMember, skippedCall, skippedOptionalCall, hits, called, nestedMissing: object.nested?.missing?.value });
    `),
    ).resolves.toEqual({
      missing: undefined,
      skippedMember: undefined,
      skippedCall: undefined,
      skippedOptionalCall: undefined,
      hits: 0,
      called: 5,
      nestedMissing: undefined,
    });
  });

  test("supports additional control flow statements", async () => {
    await expect(
      evaluateSource(`
      let total = 0;
      do {
        total++;
      } while (total < 2);

      for (const value of [1, 2, 3]) {
        total += value;
      }

      const points = { a: 4, b: 5 };
      for (const key in points) {
        total += points[key];
      }

      switch (total) {
        case 16:
          total += 100;
          break;
        case 17:
          total += 1;
          break;
        default:
          total = -1;
      }

      try {
        throw { bonus: 7 };
      } catch (error) {
        total += error.bonus;
      } finally {
        total += 1;
      }

      total;
    `),
    ).resolves.toBe(26);
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

    await expect(
      evaluateSource(
        `
      (async () => {
        let guestArg = { nested: { value: 1 } };
        let guestResult = await host.mutateAndReturn(guestArg);
        guestResult.nested.value = 11;
        return [guestArg.nested.value, guestResult.nested.value];
      })();
    `,
        { context },
      ),
    ).resolves.toEqual([1, 11]);
    expect((observedArgs[0] as { nested: { value: number } }).nested.value).toBe(99);
    expect(hostResult.nested.value).toBe(10);
  });

  test("imports host globals as reconstructed guest copies", async () => {
    const hostGlobal = { nested: { value: 1 } };
    const context = createEvaluatorContext({ globals: { hostGlobal } });

    await expect(
      evaluateSource("hostGlobal.nested.value = 2; hostGlobal.nested.value", { context }),
    ).resolves.toBe(2);

    expect(hostGlobal.nested.value).toBe(1);
    await expect(
      evaluateSource("hostGlobal.nested.value", { context }),
    ).resolves.toBe(2);
  });

  test("exports evaluator results as reconstructed host copies", async () => {
    const context = createEvaluatorContext();
    const result = await evaluateSource(
      "guestState = { nested: { value: 1 } }; guestState",
      {
        context,
      },
    );

    (result as { nested: { value: number } }).nested.value = 99;

    await expect(
      evaluateSource("guestState.nested.value", { context }),
    ).resolves.toBe(1);
  });

  test("uses VM object descriptors for guest members while exporting host clones", async () => {
    const value = (await evaluateSource(`
      const object = { kind: "guest", nested: { value: 1 } };
      const array = [1, 2, 3];

      array.length = 1;
      array[2] = object.kind;
      delete object.nested;
      object["0"] = "zero";

      ({ object, array, hasNested: "nested" in object });
    `)) as { object: { readonly [key: string]: unknown }; array: unknown[]; hasNested: boolean };

    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(Object.getPrototypeOf(value.object)).toBeNull();
    expect(Array.isArray(value.array)).toBe(true);
    expect(value).toEqual({
      object: { "0": "zero", kind: "guest" },
      array: [1, undefined, "guest"],
      hasNested: false,
    });
  });

  test("supports VM-owned built-in prototype methods without host prototype leakage", async () => {
    await expect(
      evaluateSource(`
      const values = [1, 2, 3, 4];
      const mapped = values.map(function (value) { return value * this.factor; }, { factor: 2 });
      const filtered = mapped.filter((value) => value > 4);
      let forEachTotal = 0;
      filtered.forEach((value) => { forEachTotal += value; });
      const reduced = filtered.reduce((sum, value) => sum + value, 1);
      const joined = filtered.slice(0, 2).join("-");
      values.push(5);
      const popped = values.pop();

      const object = { a: 1 };
      Object.defineProperty(object, "hidden", { value: 2, enumerable: false });
      const descriptor = Object.getOwnPropertyDescriptor(object, "hidden");
      const created = Object.create(object);
      created.b = 3;

      [
        mapped.includes(4),
        filtered,
        forEachTotal,
        reduced,
        joined,
        popped,
        values.length,
        Object.keys(object).join(","),
        Object.values(Object.assign({ z: 0 }, { a: 1 })).join(","),
        Object.entries({ x: 1 })[0].join(":"),
        descriptor.value,
        descriptor.enumerable,
        Object.getPrototypeOf(created) === object,
        Object.setPrototypeOf(created, null) === created,
        created.a
      ];
    `),
    ).resolves.toEqual([
      true,
      [6, 8],
      14,
      15,
      "6-8",
      5,
      4,
      "a",
      "0,1",
      "x:1",
      2,
      false,
      true,
      true,
      undefined,
    ]);
  });

  test("supports VM-owned String, RegExp, Date, Map, and Set operations", async () => {
    await expect(
      evaluateSource(`
      const regexp = new RegExp("a+", "g");
      const first = regexp.exec("baaa");
      const date = new Date("2024-01-02T03:04:05.000Z");
      const map = new Map([["a", 1]]);
      map.set("b", 2);
      const set = new Set([1, 2, 2]);
      set.add(3);
      let mapTotal = 0;
      map.forEach((value) => { mapTotal += value; });
      let setTotal = 0;
      set.forEach((value) => { setTotal += value; });
      [
        "hello".includes("ell"),
        "hello".slice(1, 4),
        "a,b".split(",")[1].toUpperCase(),
        regexp.test("caa"),
        first[0],
        first.index,
        date.getTime(),
        date.toISOString(),
        map.get("a"),
        map.has("b"),
        map.delete("b"),
        map.has("b"),
        map.size,
        mapTotal,
        set.has(2),
        set.delete(1),
        set.size,
        setTotal
      ];
    `),
    ).resolves.toEqual([
      true,
      "ell",
      "B",
      false,
      "aaa",
      1,
      1_704_164_645_000,
      "2024-01-02T03:04:05.000Z",
      1,
      true,
      true,
      false,
      1,
      3,
      true,
      true,
      2,
      6,
    ]);
  });

  test("supports VM-owned Error constructors and catchable TypeErrors", async () => {
    await expect(
      evaluateSource(`
      const plain = Error("plain");
      const range = new RangeError("range");
      let caught;
      try {
        throw new TypeError("boom");
      } catch (error) {
        caught = {
          name: error.name,
          message: error.message,
          typeError: error instanceof TypeError,
          error: error instanceof Error,
        };
      }

      let runtimeCaught;
      try {
        null.value;
      } catch (error) {
        runtimeCaught = {
          name: error.name,
          typeError: error instanceof TypeError,
        };
      }

      ({ plain: { name: plain.name, message: plain.message, isError: plain instanceof Error }, range: { name: range.name, message: range.message, isRange: range instanceof RangeError, isError: range instanceof Error }, caught, runtimeCaught });
    `),
    ).resolves.toEqual({
      caught: { error: true, message: "boom", name: "TypeError", typeError: true },
      plain: { isError: true, message: "plain", name: "Error" },
      range: { isError: true, isRange: true, message: "range", name: "RangeError" },
      runtimeCaught: { name: "TypeError", typeError: true },
    });
  });

  test("supports isNaN, isFinite, and Symbol.toPrimitive coercion", async () => {
    await expect(
      evaluateSource(`
      const numberLike = {
        [Symbol.toPrimitive](hint) {
          return hint === "number" ? "7" : "not-number";
        },
      };
      const nanLike = {
        [Symbol.toPrimitive]() {
          return "not-number";
        },
      };

      [
        isNaN("not-number"),
        isNaN("12"),
        isNaN(nanLike),
        isFinite("12"),
        isFinite("Infinity"),
        isFinite(numberLike),
        Number(numberLike),
        +numberLike,
      ];
    `),
    ).resolves.toEqual([true, false, true, true, false, true, 7, 7]);
  });

  test("uses ordinary ToPrimitive order for addition", async () => {
    await expect(
      evaluateSource(`
      const log = [];
      const valueFirst = {
        valueOf() { log.push("valueOf"); return 2; },
        toString() { log.push("toString"); return "bad"; },
      };
      const stringFallback = {
        valueOf() { log.push("object-valueOf"); return {}; },
        toString() { log.push("object-toString"); return "3"; },
      };
      const throwing = {
        valueOf() { throw "guest throw"; },
        toString() { return 1; },
      };
      let caught;
      try {
        1 + throwing;
      } catch (error) {
        caught = error;
      }
      [valueFirst + 1, 1 + stringFallback, log.join(","), caught];
    `),
    ).resolves.toEqual([3, "13", "valueOf,object-valueOf,object-toString", "guest throw"]);
  });

  test("supports Symbol.toPrimitive result validation and propagation", async () => {
    await expect(
      evaluateSource(`
      const primitive = {
        [Symbol.toPrimitive](hint) {
          return hint === "default" ? "ok" : 0;
        },
      };
      const bad = {
        [Symbol.toPrimitive]() {
          return {};
        },
      };
      const throwing = {
        [Symbol.toPrimitive]() {
          throw "coercion throw";
        },
      };
      let badName;
      let caught;
      try {
        bad + 1;
      } catch (error) {
        badName = error.name;
      }
      try {
        throwing + 1;
      } catch (error) {
        caught = error;
      }
      [primitive + "!", badName, caught];
    `),
    ).resolves.toEqual(["ok!", "TypeError", "coercion throw"]);
  });

  test("supports BigInt addition coercion and mixed numeric TypeErrors", async () => {
    await expect(
      evaluateSource(`
      const wrapped = Object(2n);
      const viaValueOf = { valueOf() { return 3n; } };
      const viaToString = { valueOf() { return {}; }, toString() { return 4n; } };
      let mixedName;
      let unaryName;
      try {
        1n + 1;
      } catch (error) {
        mixedName = error.name;
      }
      try {
        +1n;
      } catch (error) {
        unaryName = error.name;
      }
      [1n + 2n, wrapped + 1n, 1n + viaValueOf, viaToString + 1n, "" + 5n, mixedName, unaryName];
    `),
    ).resolves.toEqual([3n, 3n, 4n, 5n, "5", "TypeError", "TypeError"]);
  });

  test("supports VM-local Symbol identity, registry, well-known symbols, and symbol keys", async () => {
    await expect(
      evaluateSource(`
      const localA = Symbol("local");
      const localB = Symbol("local");
      const registryA = Symbol.for("shared");
      const registryB = Symbol.for("shared");
      const tag = Symbol("tag");
      const object = { [tag]: 42, plain: 1 };
      const keys = Reflect.ownKeys(object);
      let constructName;
      try {
        new Symbol("nope");
      } catch (error) {
        constructName = error.name;
      }

      ({
        localType: typeof localA,
        localDescriptionsDifferByIdentity: localA !== localB,
        registryIdentity: registryA === registryB,
        registryKey: Symbol.keyFor(registryA),
        unregisteredKey: Symbol.keyFor(localA),
        wellKnownStable: Symbol.toPrimitive === Symbol.toPrimitive && typeof Symbol.iterator === "symbol" && typeof Symbol.toStringTag === "symbol",
        symbolValue: object[tag],
        stringValue: object.plain,
        hasSymbolKey: keys.includes(tag),
        hasStringKey: keys.includes("plain"),
        constructName,
      });
    `),
    ).resolves.toEqual({
      constructName: "TypeError",
      hasStringKey: true,
      hasSymbolKey: true,
      localDescriptionsDifferByIdentity: true,
      localType: "symbol",
      registryIdentity: true,
      registryKey: "shared",
      stringValue: 1,
      symbolValue: 42,
      unregisteredKey: undefined,
      wellKnownStable: true,
    });
  });

  test("rejects VM symbols at the public boundary", async () => {
    await expect(evaluateSource(`Symbol("leak")`)).rejects.toMatchObject({
      code: VMErrorCode.BoundaryUnsupportedType,
    });

    await expect(
      evaluateSource(`
      const key = Symbol("secret");
      ({ [key]: 1, plain: 2 });
    `),
    ).rejects.toMatchObject({ code: VMErrorCode.BoundaryUnsupportedType });
  });

  test("supports VM-owned Reflect object operations", async () => {
    await expect(
      evaluateSource(`
      const proto = { inherited: 2 };
      const object = Object.create(proto);
      const defined = Reflect.defineProperty(object, "x", {
        value: 1,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      const before = Reflect.get(object, "inherited");
      const set = Reflect.set(object, "x", 3);
      const descriptor = Reflect.getOwnPropertyDescriptor(object, "x");
      const keys = Reflect.ownKeys(object);
      const had = Reflect.has(object, "x");
      const deleted = Reflect.deleteProperty(object, "x");
      const extensibleBefore = Reflect.isExtensible(object);
      const prevented = Reflect.preventExtensions(object);
      const extensibleAfter = Reflect.isExtensible(object);
      const prototypeMatches = Reflect.getPrototypeOf(object) === proto;
      const changedPrototype = Reflect.setPrototypeOf(object, null);
      ({
        defined,
        before,
        set,
        descriptor: {
          value: descriptor.value,
          writable: descriptor.writable,
          enumerable: descriptor.enumerable,
          configurable: descriptor.configurable,
        },
        keys,
        had,
        deleted,
        extensibleBefore,
        prevented,
        extensibleAfter,
        prototypeMatches,
        changedPrototype,
      });
    `),
    ).resolves.toEqual({
      before: 2,
      changedPrototype: false,
      defined: true,
      deleted: true,
      descriptor: { configurable: true, enumerable: true, value: 3, writable: true },
      extensibleAfter: false,
      extensibleBefore: true,
      had: true,
      keys: ["x"],
      prevented: true,
      prototypeMatches: true,
      set: true,
    });
  });

  test("routes VM proxy object operations through guest traps", async () => {
    await expect(
      evaluateSource(`
      const log = [];
      const target = { a: 1 };
      let proxy;
      const handler = {
        get(target, key, receiver) {
          log.push("get:" + key + ":" + (receiver === proxy));
          if (key === "virtual") return 42;
          return Reflect.get(target, key, receiver);
        },
        set(target, key, value, receiver) {
          log.push("set:" + key + ":" + value + ":" + (receiver === proxy));
          return Reflect.set(target, key, value, receiver);
        },
        has(target, key) {
          log.push("has:" + key);
          return key === "virtual" || Reflect.has(target, key);
        },
        deleteProperty(target, key) {
          log.push("delete:" + key);
          return Reflect.deleteProperty(target, key);
        },
        ownKeys() {
          log.push("ownKeys");
          return ["a", "b", "virtual"];
        },
        getOwnPropertyDescriptor(target, key) {
          log.push("desc:" + key);
          if (key === "virtual") {
            return { value: 42, enumerable: true, configurable: true };
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        defineProperty(target, key, descriptor) {
          log.push("define:" + key + ":" + descriptor.value);
          return Reflect.defineProperty(target, key, descriptor);
        },
      };
      proxy = new Proxy(target, handler);
      proxy.b = 2;
      Object.defineProperty(proxy, "c", { value: 3, enumerable: true, configurable: true });
      const keys = Object.keys(proxy);
      const values = [proxy.a, proxy.virtual, "virtual" in proxy, delete proxy.c, target.b, target.c];
      ({ keys, values, log });
    `),
    ).resolves.toEqual({
      keys: ["a", "b", "virtual"],
      log: [
        "set:b:2:true",
        "define:b:2",
        "define:c:3",
        "ownKeys",
        "desc:a",
        "desc:b",
        "desc:virtual",
        "get:a:true",
        "get:virtual:true",
        "has:virtual",
        "delete:c",
      ],
      values: [1, 42, true, true, 2, undefined],
    });
  });

  test("preserves Reflect receiver behavior through proxy traps", async () => {
    await expect(
      evaluateSource(`
      const proto = {
        get value() {
          return this.marker;
        },
        set value(next) {
          this.marker = next;
        },
      };
      const target = Object.create(proto);
      const proxy = new Proxy(target, {
        get(target, key, receiver) {
          return Reflect.get(target, key, receiver);
        },
        set(target, key, value, receiver) {
          return Reflect.set(target, key, value, receiver);
        },
      });
      const receiver = { marker: 10 };
      const before = Reflect.get(proxy, "value", receiver);
      const set = Reflect.set(proxy, "value", 11, receiver);
      ({ before, set, receiverMarker: receiver.marker, targetMarker: target.marker });
    `),
    ).resolves.toEqual({ before: 10, receiverMarker: 11, set: true, targetMarker: undefined });
  });

  test("enforces proxy invariants for fixed properties, keys, prototypes, and extensions", async () => {
    await expect(
      evaluateSource(`
      const target = {};
      Object.defineProperty(target, "fixed", {
        value: 1,
        writable: false,
        configurable: false,
      });
      new Proxy(target, { get() { return 2; } }).fixed;
    `),
    ).rejects.toMatchObject({ code: VMErrorCode.VMRuntimeError });

    await expect(
      evaluateSource(`
      const target = {};
      Object.defineProperty(target, "fixed", { value: 1, configurable: false });
      Reflect.ownKeys(new Proxy(target, { ownKeys() { return []; } }));
    `),
    ).rejects.toMatchObject({ code: VMErrorCode.VMRuntimeError });

    await expect(
      evaluateSource(`
      const target = {};
      const proxy = new Proxy(target, { preventExtensions() { return true; } });
      Reflect.preventExtensions(proxy);
    `),
    ).rejects.toMatchObject({ code: VMErrorCode.VMRuntimeError });

    await expect(
      evaluateSource(`
      const target = {};
      const proto = {};
      Reflect.setPrototypeOf(proto, target);
      const proxy = new Proxy(target, { setPrototypeOf() { return true; } });
      Reflect.setPrototypeOf(proxy, proto);
    `),
    ).rejects.toMatchObject({ code: VMErrorCode.VMRuntimeError });
  });

  test("supports callable and constructable VM proxies", async () => {
    await expect(
      evaluateSource(`
      function add(a, b) {
        return this.base + a + b;
      }
      const callable = new Proxy(add, {
        apply(target, thisArg, args) {
          return Reflect.apply(target, { base: 10 }, args);
        },
      });

      class Box {
        constructor(value) {
          this.value = value;
        }
      }
      const BoxProxy = new Proxy(Box, {
        construct(target, args) {
          const object = Reflect.construct(target, args);
          object.proxied = true;
          return object;
        },
      });

      const first = new BoxProxy(5);
      const second = Reflect.construct(BoxProxy, [6]);
      ({ sum: callable(2, 3), first, second });
    `),
    ).resolves.toEqual({
      first: { proxied: true, value: 5 },
      second: { proxied: true, value: 6 },
      sum: 15,
    });

    await expect(evaluateSource("new Proxy(function () { return 1; }, {});")).rejects.toMatchObject(
      { code: VMErrorCode.BoundaryUnsupportedType },
    );
  });

  test("reconstructs imported built-ins as VM-owned instances", async () => {
    const hostDate = new Date("2024-01-02T03:04:05.000Z");
    const hostRegExp = /a+/;
    const hostMap = new Map<unknown, unknown>([["a", 1]]);
    const hostSet = new Set<unknown>([1, 2]);
    const hostBytes = new Uint8Array([1, 2, 3]);
    const context = createEvaluatorContext({
      globals: { hostBytes, hostDate, hostMap, hostRegExp, hostSet },
    });

    await expect(
      evaluateSource(
        `
      hostMap.set("b", 2);
      hostSet.add(3);
      [
        hostDate.toISOString(),
        hostRegExp.test("caa"),
        hostMap.get("a"),
        hostMap.has("b"),
        hostSet.has(3),
        hostBytes.byteLength,
        hostDate.constructor === Date,
        hostMap.constructor === Map
      ];
    `,
        { context },
      ),
    ).resolves.toEqual(["2024-01-02T03:04:05.000Z", true, 1, true, true, 3, true, true]);
    expect(hostMap.has("b")).toBe(false);
    expect(hostSet.has(3)).toBe(false);
  });

  test("keeps host escapes absent while allowing VM-owned reserved-looking keys", async () => {
    await expect(evaluateSource("({}).constructor === Object")).resolves.toBe(
      true,
    );
    await expect(evaluateSource("({}).__proto__")).resolves.toBeUndefined();
    await expect(
      evaluateSource("({ constructor: 1, __proto__: 2, prototype: 3 }).constructor"),
    ).resolves.toBe(1);
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
    await expect(evaluateSource("this === globalThis")).resolves.toBe(true);
    const topLevelThis = await evaluateSource("this");
    expect(Object.getPrototypeOf(topLevelThis as object)).toBeNull();
    expect(topLevelThis).toEqual({});
  });

  test("uses a VM-owned globalThis for top-level this without touching the host global", async () => {
    const marker = "__jsvmGuestGlobalMarker";
    const hostGlobal = globalThis as typeof globalThis & { [marker]?: unknown };
    const context = createEvaluatorContext();
    delete hostGlobal[marker];

    try {
      await expect(
        evaluateSource(
          `
        globalThis.${marker} = 41;
        this.${marker} += 1;
        [this === globalThis, globalThis.${marker}];
      `,
          { context },
        ),
      ).resolves.toEqual([true, 42]);
      expect(hostGlobal[marker]).toBeUndefined();
      await expect(evaluateSource(`this.${marker}`, { context })).resolves.toBe(
        42,
      );
    } finally {
      delete hostGlobal[marker];
    }
  });

  test("binds this for guest member calls and ordinary function calls", async () => {
    await expect(
      evaluateSource(`
      globalThis.value = 7;
      const object = {
        value: 2,
        get() { return this.value; }
      };
      const get = object.get;
      function isGlobalThis() { return this === globalThis; }
      [object.get(), get(), (0, object.get)(), isGlobalThis()];
    `),
    ).resolves.toEqual([2, 7, 7, true]);
  });

  test("constructs guest functions with prototype objects and constructor links", async () => {
    await expect(
      evaluateSource(`
      function Point(x) {
        this.x = x;
      }
      Point.prototype.y = 3;
      const point = new Point(4);
      [
        point.x,
        point.y,
        point.constructor === Point,
        Point.prototype.constructor === Point,
        Point.length,
        Point.name
      ];
    `),
    ).resolves.toEqual([4, 3, true, true, 1, "Point"]);
  });

  test("applies guest constructor return-object rules", async () => {
    await expect(
      evaluateSource(`
      function ReturnsObject() {
        this.value = 1;
        return { value: 2 };
      }
      function ReturnsPrimitive() {
        this.value = 3;
        return 4;
      }
      [new ReturnsObject().value, new ReturnsPrimitive().value];
    `),
    ).resolves.toEqual([2, 3]);
  });

  test("supports class declarations, expressions, fields, and static members", async () => {
    await expect(
      evaluateSource(`
      class Counter {
        value = 1;
        static seed = 10;
        constructor(step) {
          this.step = step;
        }
        inc() {
          this.value += this.step;
          return this.value;
        }
        get doubled() {
          return this.value * 2;
        }
        set doubled(next) {
          this.value = next / 2;
        }
        static make(step) {
          return new this(step).inc();
        }
      }
      const Expr = class Named {
        static label = "ok";
        field = Named.label;
      };
      class Escape {}
      const counter = new Counter(3);
      const first = counter.inc();
      counter.doubled = 20;
      const expr = new Expr();
      const escaped = new Escape();
      [
        first,
        counter.value,
        counter.doubled,
        Counter.seed,
        Counter.make(2),
        expr.field,
        escaped.constructor === Escape,
        Escape.constructor === undefined,
      ];
    `),
    ).resolves.toEqual([4, 10, 20, 10, 3, "ok", true, true]);
  });

  test("supports class inheritance and super for constructors, methods, accessors, and statics", async () => {
    await expect(
      evaluateSource(`
      class Base {
        baseField = 1;
        static value = 2;
        constructor(value) {
          this.value = value;
        }
        get total() {
          return this.value + this.baseField;
        }
        set total(next) {
          this.value = next - this.baseField;
        }
        method() {
          return this.total;
        }
        static read() {
          return this.value;
        }
      }
      class Derived extends Base {
        derivedField = super.total;
        static value = 5;
        constructor(value) {
          super(value);
          this.afterSuper = super.method();
          super.total = 8;
        }
        method() {
          return super.method() + this.derivedField + this.afterSuper;
        }
        static read() {
          return super.read() + this.value;
        }
      }
      const item = new Derived(4);
      [item.value, item.baseField, item.derivedField, item.afterSuper, item.method(), Derived.read()];
    `),
    ).resolves.toEqual([7, 1, 5, 5, 18, 10]);
  });

  test("supports private fields and private methods without exporting private state", async () => {
    await expect(
      evaluateSource(`
      class Base {
        #value = 1;
        #twice() {
          return this.#value * 2;
        }
        bump() {
          this.#value += 1;
          return this.#twice();
        }
      }
      class Derived extends Base {
        #value = 10;
        read() {
          this.#value += 5;
          return super.bump() + this.#value;
        }
      }
      const item = new Derived();
      ({ result: item.read(), publicValue: item.value, privateText: item["#value"] });
    `),
    ).resolves.toEqual({ result: 19, publicValue: undefined, privateText: undefined });
  });

  test("returns cloned serializable values and rejects callable exports", async () => {
    const value = await evaluateSource(
      "({ nested: { value: 1 }, list: [1, 2] })",
    );

    expect(Object.getPrototypeOf(value as object)).toBeNull();
    expect(value).toEqual({ nested: { value: 1 }, list: [1, 2] });

    await expect(evaluateSource("() => 1")).rejects.toMatchObject({
      code: VMErrorCode.BoundaryUnsupportedType,
    });

    await expect(
      evaluateSource(`
      ({
        get callable() {
          return () => 1;
        },
      });
    `),
    ).rejects.toMatchObject({ code: VMErrorCode.BoundaryUnsupportedType });
  });

  test("fails remaining unsupported syntax with structured VM errors", async () => {
    try {
      await evaluateSource("with ({ value: 1 }) { value; }");
      throw new Error("Expected with syntax to be unsupported.");
    } catch (error) {
      const vmError = expectVMError(error, VMErrorCode.VMRuntimeError);
      expect(vmError.details.reason).toBe("unsupported syntax");
    }
  });
});
