import { describe, expect, test } from "bun:test";

import {
  createArrayLikeObject,
  createOrdinaryObject,
  createVMCallablePlaceholder,
  defineOwnProperty,
  deleteProperty,
  get,
  getOwnPropertyDescriptor,
  getPrototypeOf,
  has,
  isArrayLikeObject,
  isExtensible,
  ownKeys,
  preventExtensions,
  set,
  setPrototypeOf,
  type VMPropertyDescriptorInput,
} from "../src/interpreter/object-model";

describe("interpreter object model", () => {
  test("stores data descriptors on VM-owned null-prototype objects", () => {
    const object = createOrdinaryObject();

    expect(Object.getPrototypeOf(object)).toBeNull();
    expect((object as { constructor?: unknown }).constructor).toBeUndefined();
    expect(
      defineOwnProperty(object, "answer", {
        configurable: true,
        enumerable: true,
        kind: "data",
        value: 41,
        writable: true,
      }),
    ).toBe(true);

    const descriptor = getOwnPropertyDescriptor(object, "answer");

    expect(Object.getPrototypeOf(descriptor as object)).toBeNull();
    expect(descriptor).toEqual({
      configurable: true,
      enumerable: true,
      kind: "data",
      value: 41,
      writable: true,
    });
    expect(get(object, "answer")).toBe(41);
    expect(set(object, "answer", 42)).toBe(true);
    expect(get(object, "answer")).toBe(42);
    expect(has(object, "answer")).toBe(true);
    expect(ownKeys(object)).toEqual(["answer"]);
  });

  test("looks up prototype properties and shadows writable inherited data", () => {
    const prototype = createOrdinaryObject();
    const object = createOrdinaryObject(prototype);

    defineOwnProperty(prototype, "inherited", {
      configurable: true,
      enumerable: true,
      kind: "data",
      value: "proto",
      writable: true,
    });

    expect(getPrototypeOf(object)).toBe(prototype);
    expect(get(object, "inherited")).toBe("proto");
    expect(getOwnPropertyDescriptor(object, "inherited")).toBeUndefined();
    expect(has(object, "inherited")).toBe(true);

    expect(set(object, "inherited", "own")).toBe(true);
    expect(get(object, "inherited")).toBe("own");
    expect(get(prototype, "inherited")).toBe("proto");
    expect(ownKeys(object)).toEqual(["inherited"]);
  });

  test("preserves accessor callable placeholders without invoking host functions", () => {
    const object = createOrdinaryObject();
    const getter = createVMCallablePlaceholder("get value");
    const setter = createVMCallablePlaceholder("set value");
    let hostInvoked = false;
    const hostDescriptor: unknown = {
      get: () => {
        hostInvoked = true;
      },
      kind: "accessor",
    };

    expect(
      defineOwnProperty(object, "value", {
        configurable: true,
        enumerable: false,
        get: getter,
        kind: "accessor",
        set: setter,
      }),
    ).toBe(true);

    const descriptor = getOwnPropertyDescriptor(object, "value");

    expect(descriptor).toEqual({
      configurable: true,
      enumerable: false,
      get: getter,
      kind: "accessor",
      set: setter,
    });
    expect(typeof getter).toBe("object");
    expect(typeof setter).toBe("object");
    expect(get(object, "value")).toBeUndefined();
    expect(set(object, "value", 1)).toBe(true);
    expect(() =>
      defineOwnProperty(object, "host", hostDescriptor as VMPropertyDescriptorInput),
    ).toThrow(TypeError);
    expect(hostInvoked).toBe(false);
  });

  test("honors delete and configurable descriptor rules", () => {
    const object = createOrdinaryObject();

    defineOwnProperty(object, "fixed", {
      configurable: false,
      kind: "data",
      value: 1,
      writable: false,
    });
    defineOwnProperty(object, "loose", { configurable: true, kind: "data", value: 2 });

    expect(deleteProperty(object, "fixed")).toBe(false);
    expect(get(object, "fixed")).toBe(1);
    expect(defineOwnProperty(object, "fixed", { configurable: true })).toBe(false);
    expect(defineOwnProperty(object, "fixed", { value: 2 })).toBe(false);

    expect(deleteProperty(object, "loose")).toBe(true);
    expect(getOwnPropertyDescriptor(object, "loose")).toBeUndefined();
    expect(deleteProperty(object, "missing")).toBe(true);
  });

  test("rejects new properties on non-extensible objects while allowing writable updates", () => {
    const object = createOrdinaryObject();
    const prototype = createOrdinaryObject();

    defineOwnProperty(object, "existing", {
      configurable: true,
      kind: "data",
      value: "before",
      writable: true,
    });

    expect(preventExtensions(object)).toBe(true);
    expect(isExtensible(object)).toBe(false);
    expect(defineOwnProperty(object, "new", { value: "nope" })).toBe(false);
    expect(set(object, "new", "nope")).toBe(false);
    expect(set(object, "existing", "after")).toBe(true);
    expect(get(object, "existing")).toBe("after");
    expect(setPrototypeOf(object, prototype)).toBe(false);
    expect(getPrototypeOf(object)).toBeNull();
  });

  test("sets prototypes with cycle protection", () => {
    const parent = createOrdinaryObject();
    const child = createOrdinaryObject(parent);
    const grandchild = createOrdinaryObject(child);

    expect(setPrototypeOf(parent, grandchild)).toBe(false);
    expect(getPrototypeOf(parent)).toBeNull();
    expect(setPrototypeOf(parent, child)).toBe(false);
    expect(setPrototypeOf(child, parent)).toBe(true);
    expect(setPrototypeOf(child, null)).toBe(true);
    expect(getPrototypeOf(child)).toBeNull();
  });

  test("creates array-like objects with length and index basics", () => {
    const array = createArrayLikeObject(["a", "b"]);

    expect(isArrayLikeObject(array)).toBe(true);
    expect(isArrayLikeObject(createOrdinaryObject())).toBe(false);
    expect(get(array, "0")).toBe("a");
    expect(get(array, "1")).toBe("b");
    expect(get(array, "length")).toBe(2);
    expect(ownKeys(array)).toEqual(["0", "1", "length"]);

    expect(set(array, "2", "c")).toBe(true);
    expect(get(array, "2")).toBe("c");
    expect(get(array, "length")).toBe(3);

    expect(defineOwnProperty(array, "length", { value: 1 })).toBe(true);
    expect(get(array, "length")).toBe(1);
    expect(getOwnPropertyDescriptor(array, "1")).toBeUndefined();
    expect(getOwnPropertyDescriptor(array, "2")).toBeUndefined();

    expect(defineOwnProperty(array, "length", { writable: false })).toBe(true);
    expect(set(array, "3", "nope")).toBe(false);
    expect(get(array, "length")).toBe(1);
  });
});
