export const VMErrorCode = {
  BoundaryUnsupportedType: "BOUNDARY_UNSUPPORTED_TYPE",
  BoundaryCycle: "BOUNDARY_CYCLE",
  BoundaryInvalidSerializedValue: "BOUNDARY_INVALID_SERIALIZED_VALUE",
  BoundaryCapabilityRevoked: "BOUNDARY_CAPABILITY_REVOKED",
  VMSyntaxError: "VM_SYNTAX_ERROR",
  VMRuntimeError: "VM_RUNTIME_ERROR",
  VMSecurityError: "VM_SECURITY_ERROR",
  VMTimeoutError: "VM_TIMEOUT_ERROR",
  VMDisposed: "VM_DISPOSED",
  VMNotStarted: "VM_NOT_STARTED",
  VMSnapshotUnsupported: "VM_SNAPSHOT_UNSUPPORTED",
} as const;

export type VMErrorCode = (typeof VMErrorCode)[keyof typeof VMErrorCode];

export interface VMErrorDetails {
  readonly path?: string;
  readonly valueType?: string;
  readonly reason?: string;
}

export class VMError extends Error {
  readonly code: VMErrorCode;
  readonly details: VMErrorDetails;

  constructor(code: VMErrorCode, message: string, details: VMErrorDetails = {}) {
    super(message);
    this.name = "VMError";
    this.code = code;
    this.details = details;
  }
}

export type VMSerializablePrimitive = undefined | null | boolean | number | bigint | string;

export type VMTypedArray =
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array;

export type VMTypedArrayName =
  | "Int8Array"
  | "Uint8Array"
  | "Uint8ClampedArray"
  | "Int16Array"
  | "Uint16Array"
  | "Int32Array"
  | "Uint32Array"
  | "Float32Array"
  | "Float64Array"
  | "BigInt64Array"
  | "BigUint64Array";

export type VMSerializableValue =
  | VMSerializablePrimitive
  | readonly VMSerializableValue[]
  | { readonly [key: string]: VMSerializableValue }
  | Date
  | RegExp
  | Map<VMSerializableValue, VMSerializableValue>
  | Set<VMSerializableValue>
  | ArrayBuffer
  | VMTypedArray
  | DataView
  | VMCapabilityReference;

export type VMBoundaryValue = VMSerializableValue | VMCapability;

export interface VMCapabilityMetadata {
  readonly id: string;
  readonly name: string;
  readonly arity?: number;
  readonly description?: string;
}

export interface VMCapabilityReference {
  readonly kind: "capability";
  readonly metadata: VMCapabilityMetadata;
}

export type VMCapabilityHandler = (
  ...args: VMSerializableValue[]
) => VMBoundaryValue | Promise<VMBoundaryValue>;

export interface VMCapability {
  readonly kind: "capability";
  readonly metadata: VMCapabilityMetadata;
  readonly revoked: boolean;
  invoke(...args: unknown[]): Promise<VMSerializableValue>;
  revoke(): void;
}

export interface CreateVMCapabilityOptions {
  readonly id?: string;
  readonly arity?: number;
  readonly description?: string;
}

export interface BoundarySerializationOptions {
  readonly allowCapabilities?: boolean;
}

export type VMSerializedValue =
  | { readonly kind: "undefined" }
  | { readonly kind: "null" }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "bigint"; readonly value: string }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "array"; readonly items: readonly VMSerializedValue[] }
  | { readonly kind: "object"; readonly entries: readonly (readonly [string, VMSerializedValue])[] }
  | { readonly kind: "date"; readonly time: number }
  | {
      readonly kind: "regexp";
      readonly source: string;
      readonly flags: string;
      readonly lastIndex: number;
    }
  | {
      readonly kind: "map";
      readonly entries: readonly (readonly [VMSerializedValue, VMSerializedValue])[];
    }
  | { readonly kind: "set"; readonly values: readonly VMSerializedValue[] }
  | { readonly kind: "arrayBuffer"; readonly bytes: readonly number[] }
  | {
      readonly kind: "typedArray";
      readonly type: VMTypedArrayName;
      readonly bytes: readonly number[];
    }
  | { readonly kind: "dataView"; readonly bytes: readonly number[] }
  | { readonly kind: "capability"; readonly metadata: VMCapabilityMetadata };

interface SerializationState {
  readonly active: WeakSet<object>;
  readonly allowCapabilities: boolean;
}

interface CapabilityRecord {
  readonly metadata: VMCapabilityMetadata;
  readonly handler: VMCapabilityHandler;
  revoked: boolean;
}

const capabilityRecords = new WeakMap<object, CapabilityRecord>();
let nextCapabilityId = 1;

const objectToString = Object.prototype.toString;
const hasOwn = Object.prototype.hasOwnProperty;
const typedArrayTags: Record<string, VMTypedArrayName | undefined> = {
  "[object Int8Array]": "Int8Array",
  "[object Uint8Array]": "Uint8Array",
  "[object Uint8ClampedArray]": "Uint8ClampedArray",
  "[object Int16Array]": "Int16Array",
  "[object Uint16Array]": "Uint16Array",
  "[object Int32Array]": "Int32Array",
  "[object Uint32Array]": "Uint32Array",
  "[object Float32Array]": "Float32Array",
  "[object Float64Array]": "Float64Array",
  "[object BigInt64Array]": "BigInt64Array",
  "[object BigUint64Array]": "BigUint64Array",
};

const typedArrayConstructors: Record<VMTypedArrayName, new (buffer: ArrayBuffer) => VMTypedArray> =
  {
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array,
  };

export function createCapability(
  name: string,
  handler: VMCapabilityHandler,
  options: CreateVMCapabilityOptions = {},
): VMCapability {
  if (typeof name !== "string" || name.length === 0) {
    throw unsupported("$", name, "Capability names must be non-empty strings.");
  }

  if (typeof handler !== "function") {
    throw unsupported("$", handler, "Capability handlers must be functions.");
  }

  const metadataCandidate = {
    id: options.id ?? `capability:${nextCapabilityId++}`,
    name,
    arity: options.arity ?? handler.length,
    description: options.description,
  };

  if (!isCapabilityMetadata(metadataCandidate)) {
    throw unsupported("$", metadataCandidate, "Capability metadata is invalid.");
  }

  const metadata = freezeCapabilityMetadata(metadataCandidate);

  const capability = Object.create(null) as VMCapability;
  const record: CapabilityRecord = { metadata, handler, revoked: false };

  Object.defineProperties(capability, {
    kind: { enumerable: true, value: "capability" },
    metadata: { enumerable: true, value: metadata },
    revoked: { enumerable: true, get: () => record.revoked },
    invoke: {
      enumerable: false,
      value: (...args: unknown[]) => invokeBoundaryCapability(capability, args),
    },
    revoke: {
      enumerable: false,
      value: () => {
        record.revoked = true;
      },
    },
  });

  capabilityRecords.set(capability, record);
  return Object.freeze(capability);
}

export function isVMCapability(value: unknown): value is VMCapability {
  return typeof value === "object" && value !== null && capabilityRecords.has(value);
}

export function isVMCapabilityReference(value: unknown): value is VMCapabilityReference {
  if (!isPlainRecord(value)) {
    return false;
  }

  return value.kind === "capability" && isCapabilityMetadata(value.metadata);
}

export async function invokeBoundaryCapability(
  capability: VMCapability,
  args: readonly unknown[],
): Promise<VMSerializableValue> {
  const record = capabilityRecords.get(capability);

  if (record === undefined) {
    throw unsupported("$", capability, "Expected a VM capability created by createCapability().");
  }

  if (record.revoked) {
    throw new VMError(
      VMErrorCode.BoundaryCapabilityRevoked,
      `Capability "${record.metadata.name}" has been revoked.`,
      { reason: "revoked capability" },
    );
  }

  const safeArgs = args.map((arg, index) =>
    serializeAndReconstructBoundaryValueAtPath(arg, { allowCapabilities: false }, `$[${index}]`),
  );
  const result = await record.handler(...safeArgs);
  return serializeAndReconstructBoundaryValue(result, { allowCapabilities: true });
}

export function serializeBoundaryValue(
  value: unknown,
  options: BoundarySerializationOptions = {},
): VMSerializedValue {
  return serialize(value, "$", {
    active: new WeakSet<object>(),
    allowCapabilities: options.allowCapabilities ?? true,
  });
}

export function reconstructBoundaryValue(value: VMSerializedValue): VMSerializableValue {
  return deserialize(value, "$");
}

export const deserializeBoundaryValue = reconstructBoundaryValue;

/**
 * Serializes a boundary value and reconstructs it into fresh objects.
 *
 * This is the only supported way to copy data across the host/VM boundary:
 * host object identity, mutable references, and custom prototypes are not kept.
 */
export function serializeAndReconstructBoundaryValue(
  value: unknown,
  options: BoundarySerializationOptions = {},
): VMSerializableValue {
  return serializeAndReconstructBoundaryValueAtPath(value, options, "$");
}

export function cloneBoundaryValue(
  value: unknown,
  options: BoundarySerializationOptions = {},
): VMSerializableValue {
  return serializeAndReconstructBoundaryValue(value, options);
}

function serializeAndReconstructBoundaryValueAtPath(
  value: unknown,
  options: BoundarySerializationOptions,
  path: string,
): VMSerializableValue {
  const serialized = serialize(value, path, {
    active: new WeakSet<object>(),
    allowCapabilities: options.allowCapabilities ?? true,
  });

  return reconstructBoundaryValue(serialized);
}

export function isBoundarySerializable(
  value: unknown,
  options: BoundarySerializationOptions = {},
): value is VMBoundaryValue {
  try {
    serializeBoundaryValue(value, options);
    return true;
  } catch (error) {
    if (error instanceof VMError) {
      return false;
    }

    throw error;
  }
}

function serialize(value: unknown, path: string, state: SerializationState): VMSerializedValue {
  if (value === undefined) {
    return { kind: "undefined" };
  }

  if (value === null) {
    return { kind: "null" };
  }

  switch (typeof value) {
    case "boolean":
      return { kind: "boolean", value };
    case "number":
      return { kind: "number", value };
    case "bigint":
      return { kind: "bigint", value: value.toString() };
    case "string":
      return { kind: "string", value };
    case "symbol":
      throw unsupported(path, value, "Symbols cannot cross the VM boundary.");
    case "function":
      throw unsupported(
        path,
        value,
        "Functions must be wrapped with createCapability() before crossing the VM boundary.",
      );
  }

  if (isVMCapability(value)) {
    if (!state.allowCapabilities) {
      throw unsupported(path, value, "Capabilities are not allowed in this boundary position.");
    }

    const record = capabilityRecords.get(value);

    if (record === undefined) {
      throw unsupported(path, value, "Unknown capability wrapper.");
    }

    return { kind: "capability", metadata: record.metadata };
  }

  const objectValue = value as object;
  enterObject(objectValue, path, state);

  try {
    const tag = objectToString.call(value);

    if (Array.isArray(value)) {
      return serializeArray(value, path, state);
    }

    if (tag === "[object Date]") {
      assertNoUnexpectedProperties(value, path, new Set<string>());
      return { kind: "date", time: getDateTime(value, path) };
    }

    if (tag === "[object RegExp]") {
      assertNoUnexpectedProperties(value, path, new Set<string>(["lastIndex"]));
      return serializeRegExp(value, path);
    }

    if (tag === "[object Map]") {
      assertNoUnexpectedProperties(value, path, new Set<string>());
      const entries: (readonly [VMSerializedValue, VMSerializedValue])[] = [];
      let index = 0;
      try {
        Map.prototype.forEach.call(value, (entryValue: unknown, entryKey: unknown) => {
          entries.push([
            serialize(entryKey, `${path}<map[${index}].key>`, state),
            serialize(entryValue, `${path}<map[${index}].value>`, state),
          ]);
          index += 1;
        });
      } catch (error) {
        if (error instanceof VMError) {
          throw error;
        }

        throw unsupported(path, value, "Map values must be readable Map instances.");
      }
      return { kind: "map", entries };
    }

    if (tag === "[object Set]") {
      assertNoUnexpectedProperties(value, path, new Set<string>());
      const values: VMSerializedValue[] = [];
      let index = 0;
      try {
        Set.prototype.forEach.call(value, (entryValue: unknown) => {
          values.push(serialize(entryValue, `${path}<set[${index}]>`, state));
          index += 1;
        });
      } catch (error) {
        if (error instanceof VMError) {
          throw error;
        }

        throw unsupported(path, value, "Set values must be readable Set instances.");
      }
      return { kind: "set", values };
    }

    if (tag === "[object ArrayBuffer]") {
      assertNoUnexpectedProperties(value, path, new Set<string>());
      return { kind: "arrayBuffer", bytes: copyBytes(value as ArrayBuffer, path) };
    }

    if (tag === "[object DataView]") {
      assertNoUnexpectedProperties(value, path, new Set<string>());
      const view = value as DataView;
      return { kind: "dataView", bytes: copyViewBytes(view, path) };
    }

    const typedArrayName = typedArrayTags[tag];

    if (typedArrayName !== undefined) {
      assertNoUnexpectedTypedArrayProperties(value as VMTypedArray, path);
      return {
        kind: "typedArray",
        type: typedArrayName,
        bytes: copyViewBytes(value as ArrayBufferView, path),
      };
    }

    if (tag === "[object WeakMap]" || tag === "[object WeakSet]") {
      throw unsupported(path, value, "Weak collections cannot cross the VM boundary.");
    }

    if (tag === "[object Promise]") {
      throw unsupported(path, value, "Promises cannot cross the VM boundary as values.");
    }

    if (isPlainObjectLike(value)) {
      return serializePlainObject(value, path, state);
    }

    throw unsupported(
      path,
      value,
      "Only primitives, arrays, plain objects, supported built-ins, and explicit capabilities can cross the VM boundary.",
    );
  } finally {
    state.active.delete(objectValue);
  }
}

function serializeArray(
  value: readonly unknown[],
  path: string,
  state: SerializationState,
): VMSerializedValue {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const symbolKeys = Object.getOwnPropertySymbols(value);

  if (symbolKeys.length > 0) {
    throw unsupported(path, value, "Arrays with symbol properties cannot cross the VM boundary.");
  }

  for (const key of Object.keys(descriptors)) {
    if (key === "length" || isArrayIndex(key)) {
      continue;
    }

    throw unsupported(pathForProperty(path, key), value, "Arrays cannot carry custom properties.");
  }

  const items: VMSerializedValue[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];

    if (descriptor === undefined) {
      items.push({ kind: "undefined" });
      continue;
    }

    if (!isSerializableDataDescriptor(descriptor) || descriptor.enumerable !== true) {
      throw unsupported(
        `${path}[${index}]`,
        value,
        "Array entries must be enumerable data properties.",
      );
    }

    items.push(serialize(descriptor.value, `${path}[${index}]`, state));
  }

  return { kind: "array", items };
}

function serializePlainObject(
  value: object,
  path: string,
  state: SerializationState,
): VMSerializedValue {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const symbolKeys = Object.getOwnPropertySymbols(value);

  if (symbolKeys.length > 0) {
    throw unsupported(path, value, "Objects with symbol properties cannot cross the VM boundary.");
  }

  const entries: (readonly [string, VMSerializedValue])[] = [];

  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!isSerializableDataDescriptor(descriptor) || descriptor.enumerable !== true) {
      throw unsupported(
        pathForProperty(path, key),
        value,
        "Object properties must be enumerable data properties.",
      );
    }

    entries.push([key, serialize(descriptor.value, pathForProperty(path, key), state)]);
  }

  return { kind: "object", entries };
}

function deserialize(value: VMSerializedValue, path: string): VMSerializableValue {
  if (!isPlainRecord(value) || typeof value.kind !== "string") {
    throw invalidSerialized(path, "Serialized values must be tagged records.");
  }

  switch (value.kind) {
    case "undefined":
      return undefined;
    case "null":
      return null;
    case "boolean":
      if (typeof value.value !== "boolean") {
        throw invalidSerialized(path, "Invalid boolean payload.");
      }
      return value.value;
    case "number":
      if (typeof value.value !== "number") {
        throw invalidSerialized(path, "Invalid number payload.");
      }
      return value.value;
    case "bigint":
      if (typeof value.value !== "string") {
        throw invalidSerialized(path, "Invalid bigint payload.");
      }
      return reconstructBigInt(value.value, path);
    case "string":
      if (typeof value.value !== "string") {
        throw invalidSerialized(path, "Invalid string payload.");
      }
      return value.value;
    case "array": {
      if (!Array.isArray(value.items)) {
        throw invalidSerialized(path, "Invalid array payload.");
      }
      return value.items.map((item, index) => deserialize(item, `${path}[${index}]`));
    }
    case "object": {
      if (!Array.isArray(value.entries)) {
        throw invalidSerialized(path, "Invalid object payload.");
      }
      const output = Object.create(null) as Record<string, VMSerializableValue>;

      for (let index = 0; index < value.entries.length; index += 1) {
        const entry = value.entries[index];

        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
          throw invalidSerialized(`${path}.entries[${index}]`, "Invalid object entry.");
        }

        Object.defineProperty(output, entry[0], {
          configurable: true,
          enumerable: true,
          value: deserialize(entry[1], pathForProperty(path, entry[0])),
          writable: true,
        });
      }

      return output;
    }
    case "date":
      if (typeof value.time !== "number") {
        throw invalidSerialized(path, "Invalid date payload.");
      }
      return new Date(value.time);
    case "regexp":
      if (
        typeof value.source !== "string" ||
        typeof value.flags !== "string" ||
        typeof value.lastIndex !== "number"
      ) {
        throw invalidSerialized(path, "Invalid RegExp payload.");
      }
      return reconstructRegExp(value.source, value.flags, value.lastIndex, path);
    case "map": {
      if (!Array.isArray(value.entries)) {
        throw invalidSerialized(path, "Invalid Map payload.");
      }
      const output = new Map<VMSerializableValue, VMSerializableValue>();

      for (let index = 0; index < value.entries.length; index += 1) {
        const entry = value.entries[index];

        if (!Array.isArray(entry) || entry.length !== 2) {
          throw invalidSerialized(`${path}.entries[${index}]`, "Invalid Map entry.");
        }

        output.set(
          deserialize(entry[0], `${path}<map[${index}].key>`),
          deserialize(entry[1], `${path}<map[${index}].value>`),
        );
      }

      return output;
    }
    case "set": {
      if (!Array.isArray(value.values)) {
        throw invalidSerialized(path, "Invalid Set payload.");
      }
      const output = new Set<VMSerializableValue>();

      for (let index = 0; index < value.values.length; index += 1) {
        output.add(deserialize(value.values[index], `${path}<set[${index}]>`));
      }

      return output;
    }
    case "arrayBuffer":
      return bytesToArrayBuffer(value.bytes, path);
    case "typedArray": {
      if (typeof value.type !== "string" || !(value.type in typedArrayConstructors)) {
        throw invalidSerialized(path, "Invalid typed array type.");
      }
      const buffer = bytesToArrayBuffer(value.bytes, path);
      return reconstructTypedArray(value.type, buffer, path);
    }
    case "dataView":
      return new DataView(bytesToArrayBuffer(value.bytes, path));
    case "capability": {
      if (!isCapabilityMetadata(value.metadata)) {
        throw invalidSerialized(path, "Invalid capability metadata.");
      }
      return createCapabilityReference(value.metadata);
    }
  }

  throw invalidSerialized(
    path,
    `Unsupported serialized kind "${String((value as { readonly kind: unknown }).kind)}".`,
  );
}

function createCapabilityReference(metadata: VMCapabilityMetadata): VMCapabilityReference {
  const reference = Object.create(null) as VMCapabilityReference;

  Object.defineProperties(reference, {
    kind: { enumerable: true, value: "capability" },
    metadata: { enumerable: true, value: freezeCapabilityMetadata(metadata) },
  });

  return Object.freeze(reference);
}

function freezeCapabilityMetadata(metadata: VMCapabilityMetadata): VMCapabilityMetadata {
  const clean = Object.create(null) as {
    id: string;
    name: string;
    arity?: number;
    description?: string;
  };

  clean.id = metadata.id;
  clean.name = metadata.name;

  if (metadata.arity !== undefined) {
    clean.arity = metadata.arity;
  }

  if (metadata.description !== undefined) {
    clean.description = metadata.description;
  }

  return Object.freeze(clean);
}

function enterObject(value: object, path: string, state: SerializationState): void {
  if (state.active.has(value)) {
    throw new VMError(VMErrorCode.BoundaryCycle, `Cycle detected at ${path}.`, {
      path,
      valueType: describeValue(value),
      reason: "cycle",
    });
  }

  state.active.add(value);
}

function assertNoUnexpectedProperties(
  value: object,
  path: string,
  allowedStringKeys: ReadonlySet<string>,
): void {
  const keys = Reflect.ownKeys(value);

  for (const key of keys) {
    if (typeof key !== "string") {
      throw unsupported(
        path,
        value,
        "Built-in values with symbol properties cannot cross the VM boundary.",
      );
    }

    if (!allowedStringKeys.has(key)) {
      throw unsupported(
        pathForProperty(path, key),
        value,
        "Built-in values cannot carry custom properties across the VM boundary.",
      );
    }
  }
}

function assertNoUnexpectedTypedArrayProperties(value: VMTypedArray, path: string): void {
  const length = value.length;

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw unsupported(
        path,
        value,
        "Typed arrays with symbol properties cannot cross the VM boundary.",
      );
    }

    if (isArrayIndex(key) && Number(key) < length) {
      continue;
    }

    throw unsupported(
      pathForProperty(path, key),
      value,
      "Typed arrays cannot carry custom properties across the VM boundary.",
    );
  }
}

function isSerializableDataDescriptor(
  descriptor: PropertyDescriptor,
): descriptor is PropertyDescriptor & { value: unknown } {
  return "value" in descriptor && descriptor.get === undefined && descriptor.set === undefined;
}

function isPlainObjectLike(value: object): boolean {
  if (objectToString.call(value) !== "[object Object]") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  if (prototype === null) {
    return true;
  }

  return Object.getPrototypeOf(prototype) === null && hasOwn.call(prototype, "constructor");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCapabilityMetadata(value: unknown): value is VMCapabilityMetadata {
  if (!isPlainRecord(value)) {
    return false;
  }

  const arity = value.arity;
  const description = value.description;

  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    (arity === undefined || (typeof arity === "number" && Number.isInteger(arity) && arity >= 0)) &&
    (description === undefined || typeof description === "string")
  );
}

function copyBytes(buffer: ArrayBuffer, path: string): number[] {
  try {
    return Array.from(new Uint8Array(buffer));
  } catch {
    throw unsupported(path, buffer, "ArrayBuffer values must be readable and not detached.");
  }
}

function copyViewBytes(view: ArrayBufferView, path: string): number[] {
  try {
    return Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  } catch {
    throw unsupported(path, view, "ArrayBuffer views must be readable and not detached.");
  }
}

function bytesToArrayBuffer(bytes: unknown, path: string): ArrayBuffer {
  if (!Array.isArray(bytes)) {
    throw invalidSerialized(path, "Byte payloads must be arrays.");
  }

  const output = new Uint8Array(bytes.length);

  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];

    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw invalidSerialized(
        `${path}.bytes[${index}]`,
        "Bytes must be integers between 0 and 255.",
      );
    }

    output[index] = byte;
  }

  return output.buffer;
}

function getDateTime(value: object, path: string): number {
  try {
    return Date.prototype.getTime.call(value);
  } catch {
    throw unsupported(path, value, "Date values must be readable Date instances.");
  }
}

function serializeRegExp(value: object, path: string): VMSerializedValue {
  try {
    const regexp = value as RegExp;

    return {
      kind: "regexp",
      source: regexp.source,
      flags: regexp.flags,
      lastIndex: regexp.lastIndex,
    };
  } catch {
    throw unsupported(path, value, "RegExp values must be readable RegExp instances.");
  }
}

function reconstructTypedArray(
  type: VMTypedArrayName,
  buffer: ArrayBuffer,
  path: string,
): VMTypedArray {
  try {
    return new typedArrayConstructors[type](buffer);
  } catch {
    throw invalidSerialized(path, "Typed array byte length is invalid for the requested type.");
  }
}

function reconstructRegExp(source: string, flags: string, lastIndex: number, path: string): RegExp {
  try {
    const regexp = new RegExp(source, flags);
    regexp.lastIndex = lastIndex;
    return regexp;
  } catch {
    throw invalidSerialized(path, "Invalid RegExp source or flags.");
  }
}

function reconstructBigInt(value: string, path: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw invalidSerialized(path, "Invalid bigint payload.");
  }
}

function isArrayIndex(value: string): boolean {
  if (value.length === 0) {
    return false;
  }

  const numberValue = Number(value);
  return (
    Number.isInteger(numberValue) &&
    numberValue >= 0 &&
    numberValue < 2 ** 32 - 1 &&
    String(numberValue) === value
  );
}

function pathForProperty(parent: string, key: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
    return `${parent}.${key}`;
  }

  return `${parent}[${JSON.stringify(key)}]`;
}

function unsupported(path: string, value: unknown, reason: string): VMError {
  return new VMError(
    VMErrorCode.BoundaryUnsupportedType,
    `Unsupported VM boundary value at ${path}: ${reason}`,
    { path, reason, valueType: describeValue(value) },
  );
}

function invalidSerialized(path: string, reason: string): VMError {
  return new VMError(
    VMErrorCode.BoundaryInvalidSerializedValue,
    `Invalid serialized VM boundary value at ${path}: ${reason}`,
    { path, reason },
  );
}

function describeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }

  const type = typeof value;

  if (type !== "object") {
    return type;
  }

  return objectToString.call(value).slice(8, -1);
}
