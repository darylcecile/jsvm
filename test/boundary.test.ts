import { describe, expect, test } from "bun:test";

import {
  VMError,
  VMErrorCode,
  cloneBoundaryValue,
  createCapability,
  invokeBoundaryCapability,
  serializeBoundaryValue,
} from "../src/index";

describe("boundary serialization", () => {
  test("clones supported values without preserving custom object prototypes", () => {
    const input = {
      array: [1, undefined, "three"],
      date: new Date("2024-01-02T03:04:05.000Z"),
      regexp: /hello/gi,
      map: new Map([[{ key: "safe" }, new Set([1, 2])]]),
      typed: new Uint16Array([1, 513]),
    };

    const output = cloneBoundaryValue(input) as Record<string, unknown>;

    expect(Object.getPrototypeOf(output)).toBeNull();
    expect(output).toMatchObject({ array: [1, undefined, "three"] });
    expect(output.date).toEqual(input.date);
    expect(output.regexp).toEqual(input.regexp);
    expect(output.map).toBeInstanceOf(Map);
    expect(output.typed).toBeInstanceOf(Uint16Array);
    expect(Array.from(output.typed as Uint16Array)).toEqual([1, 513]);

    const map = output.map as Map<object, Set<number>>;
    const [mapKey] = map.keys();
    expect(Object.getPrototypeOf(mapKey)).toBeNull();
  });

  test("rejects cycles and unsupported boundary values with VMError codes", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;

    expect(() => cloneBoundaryValue(cycle)).toThrow(VMError);

    try {
      cloneBoundaryValue(cycle);
    } catch (error) {
      expect(error).toBeInstanceOf(VMError);
      expect((error as VMError).code).toBe(VMErrorCode.BoundaryCycle);
    }

    expect(() => cloneBoundaryValue({ fn: () => undefined })).toThrow(VMError);
    expect(() => cloneBoundaryValue(Promise.resolve(1))).toThrow(VMError);
    expect(() => cloneBoundaryValue(new (class HostThing {})())).toThrow(VMError);
  });

  test("serializes explicit capability wrappers as metadata and clones arguments", async () => {
    const capability = createCapability("sum", (value) => {
      expect(Object.getPrototypeOf(value)).toBeNull();
      return (value as { a: number; b: number }).a + (value as { a: number; b: number }).b;
    });

    expect(serializeBoundaryValue(capability)).toEqual({
      kind: "capability",
      metadata: { id: capability.metadata.id, name: "sum", arity: 1 },
    });

    await expect(invokeBoundaryCapability(capability, [{ a: 2, b: 3 }])).resolves.toBe(5);

    capability.revoke();
    await expect(invokeBoundaryCapability(capability, [])).rejects.toMatchObject({
      code: VMErrorCode.BoundaryCapabilityRevoked,
    });
  });

  test("reconstructs capability arguments and results without shared references", async () => {
    const hostArg = { nested: { value: 1 } };
    const hostResult = { nested: { value: 10 } };
    let observedArg: { nested: { value: number } } | undefined;

    const capability = createCapability("copy", (value) => {
      observedArg = value as { nested: { value: number } };
      observedArg.nested.value = 2;
      return hostResult;
    });

    const result = await invokeBoundaryCapability(capability, [hostArg]);

    expect(hostArg.nested.value).toBe(1);
    expect(observedArg).toBeDefined();
    expect(observedArg).not.toBe(hostArg);
    expect(observedArg?.nested).not.toBe(hostArg.nested);
    expect(Object.getPrototypeOf(observedArg as object)).toBeNull();

    expect(result).toEqual({ nested: { value: 10 } });
    expect(result).not.toBe(hostResult);
    (result as { nested: { value: number } }).nested.value = 99;
    expect(hostResult.nested.value).toBe(10);
  });
});
