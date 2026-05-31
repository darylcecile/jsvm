import { isVMSymbol, type VMSymbol } from "./values";

export type VMPropertyKey = string | VMSymbol;
export type VMObjectKind = "ordinary" | "array";

export interface VMObject {
  readonly kind: "vm-object";
}

export interface VMCallablePlaceholder {
  readonly kind: "vm-callable";
  readonly name?: string;
}

export type VMCallableReference = VMCallablePlaceholder | VMObject;

export interface VMDescriptorAttributes {
  readonly enumerable?: boolean;
  readonly configurable?: boolean;
}

export interface VMGenericPropertyDescriptorInput extends VMDescriptorAttributes {
  readonly kind?: undefined;
  readonly get?: never;
  readonly set?: never;
  readonly value?: never;
  readonly writable?: never;
}

export interface VMDataPropertyDescriptorInput extends VMDescriptorAttributes {
  readonly kind?: "data";
  readonly get?: never;
  readonly set?: never;
  readonly value?: unknown;
  readonly writable?: boolean;
}

export interface VMAccessorPropertyDescriptorInput extends VMDescriptorAttributes {
  readonly kind?: "accessor";
  readonly get?: VMCallableReference | null;
  readonly set?: VMCallableReference | null;
  readonly value?: never;
  readonly writable?: never;
}

export type VMPropertyDescriptorInput =
  | VMGenericPropertyDescriptorInput
  | VMDataPropertyDescriptorInput
  | VMAccessorPropertyDescriptorInput;

export interface VMDataPropertyDescriptor {
  readonly kind: "data";
  readonly value: unknown;
  readonly writable: boolean;
  readonly enumerable: boolean;
  readonly configurable: boolean;
}

export interface VMAccessorPropertyDescriptor {
  readonly kind: "accessor";
  readonly get: VMCallableReference | null;
  readonly set: VMCallableReference | null;
  readonly enumerable: boolean;
  readonly configurable: boolean;
}

export type VMPropertyDescriptor = VMDataPropertyDescriptor | VMAccessorPropertyDescriptor;

interface VMObjectRecord {
  readonly objectKind: VMObjectKind;
  prototype: VMObject | null;
  extensible: boolean;
  readonly properties: Map<VMPropertyKey, VMPropertyRecord>;
}

interface VMDataPropertyRecord {
  readonly kind: "data";
  value: unknown;
  writable: boolean;
  enumerable: boolean;
  configurable: boolean;
}

interface VMAccessorPropertyRecord {
  readonly kind: "accessor";
  get: VMCallableReference | null;
  set: VMCallableReference | null;
  enumerable: boolean;
  configurable: boolean;
}

type VMPropertyRecord = VMDataPropertyRecord | VMAccessorPropertyRecord;

interface NormalizedPropertyDescriptor {
  readonly kind: "data" | "accessor" | undefined;
  readonly hasValue: boolean;
  readonly value: unknown;
  readonly hasWritable: boolean;
  readonly writable: boolean | undefined;
  readonly hasGet: boolean;
  readonly get: VMCallableReference | null | undefined;
  readonly hasSet: boolean;
  readonly set: VMCallableReference | null | undefined;
  readonly hasEnumerable: boolean;
  readonly enumerable: boolean | undefined;
  readonly hasConfigurable: boolean;
  readonly configurable: boolean | undefined;
}

const objectRecords = new WeakMap<VMObject, VMObjectRecord>();
const callableRecords = new WeakSet<VMCallablePlaceholder>();
const hasOwn = Object.prototype.hasOwnProperty;
const maxArrayLength = 2 ** 32 - 1;

export function createOrdinaryObject(prototype: VMObject | null = null): VMObject {
  assertPrototype(prototype);
  return createObject("ordinary", prototype);
}

export function createArrayLikeObject(
  elements: readonly unknown[] = [],
  prototype: VMObject | null = null,
): VMObject {
  assertPrototype(prototype);

  if (elements.length > maxArrayLength) {
    throw new RangeError("Array-like objects cannot exceed the maximum ECMAScript array length.");
  }

  const object = createObject("array", prototype);

  for (let index = 0; index < elements.length; index += 1) {
    defineOwnProperty(object, String(index), {
      configurable: true,
      enumerable: true,
      kind: "data",
      value: elements[index],
      writable: true,
    });
  }

  defineArrayLength(object, elements.length, true);
  return object;
}

export function createVMCallablePlaceholder(name?: string): VMCallablePlaceholder {
  const callable = Object.create(null) as VMCallablePlaceholder;

  Object.defineProperty(callable, "kind", { enumerable: true, value: "vm-callable" });

  if (name !== undefined) {
    Object.defineProperty(callable, "name", { enumerable: true, value: name });
  }

  callableRecords.add(callable);
  return Object.freeze(callable);
}

export function isVMObject(value: unknown): value is VMObject {
  return typeof value === "object" && value !== null && objectRecords.has(value as VMObject);
}

export function isArrayLikeObject(value: unknown): value is VMObject {
  return isVMObject(value) && getObjectRecord(value).objectKind === "array";
}

export function isVMCallableReference(value: unknown): value is VMCallableReference {
  if (isVMObject(value)) {
    return true;
  }

  return (
    typeof value === "object" &&
    value !== null &&
    callableRecords.has(value as VMCallablePlaceholder)
  );
}

export function getPrototypeOf(object: VMObject): VMObject | null {
  return getObjectRecord(object).prototype;
}

export function setPrototypeOf(object: VMObject, prototype: VMObject | null): boolean {
  assertPrototype(prototype);

  const record = getObjectRecord(object);

  if (record.prototype === prototype) {
    return true;
  }

  if (!record.extensible || wouldCreatePrototypeCycle(object, prototype)) {
    return false;
  }

  record.prototype = prototype;
  return true;
}

export function isExtensible(object: VMObject): boolean {
  return getObjectRecord(object).extensible;
}

export function preventExtensions(object: VMObject): boolean {
  getObjectRecord(object).extensible = false;
  return true;
}

export function getOwnPropertyDescriptor(
  object: VMObject,
  key: VMPropertyKey,
): VMPropertyDescriptor | undefined {
  assertPropertyKey(key);

  const descriptor = getObjectRecord(object).properties.get(key);
  return descriptor === undefined ? undefined : copyPropertyDescriptor(descriptor);
}

export function defineOwnProperty(
  object: VMObject,
  key: VMPropertyKey,
  descriptor: VMPropertyDescriptorInput,
): boolean {
  assertPropertyKey(key);

  const record = getObjectRecord(object);

  if (record.objectKind === "array") {
    return defineArrayProperty(object, record, key, descriptor);
  }

  return defineOrdinaryOwnProperty(record, key, descriptor);
}

export function has(object: VMObject, key: VMPropertyKey): boolean {
  assertPropertyKey(key);
  return getPropertyRecord(object, key) !== undefined;
}

export function get(object: VMObject, key: VMPropertyKey): unknown {
  assertPropertyKey(key);

  const descriptor = getPropertyRecord(object, key);

  if (descriptor === undefined || descriptor.kind === "accessor") {
    return undefined;
  }

  return descriptor.value;
}

export function set(object: VMObject, key: VMPropertyKey, value: unknown): boolean {
  assertPropertyKey(key);
  return setProperty(object, object, key, value);
}

export function deleteProperty(object: VMObject, key: VMPropertyKey): boolean {
  assertPropertyKey(key);

  const properties = getObjectRecord(object).properties;
  const descriptor = properties.get(key);

  if (descriptor === undefined) {
    return true;
  }

  if (!descriptor.configurable) {
    return false;
  }

  properties.delete(key);
  return true;
}

export function ownKeys(object: VMObject): readonly VMPropertyKey[] {
  const record = getObjectRecord(object);
  const keys = Array.from(record.properties.keys());

  if (record.objectKind !== "array") {
    return Object.freeze(keys);
  }

  const indexKeys = keys.filter(isArrayIndex).sort((left, right) => Number(left) - Number(right));
  const stringKeys = keys.filter(
    (key): key is string => typeof key === "string" && !isArrayIndex(key),
  );
  const symbolKeys = keys.filter(isVMSymbol);

  return Object.freeze([...indexKeys, ...stringKeys, ...symbolKeys]);
}

function createObject(objectKind: VMObjectKind, prototype: VMObject | null): VMObject {
  const object = Object.create(null) as VMObject;

  Object.defineProperty(object, "kind", { enumerable: false, value: "vm-object" });

  objectRecords.set(object, { extensible: true, objectKind, properties: new Map(), prototype });

  return Object.freeze(object);
}

function getObjectRecord(object: VMObject): VMObjectRecord {
  const record = objectRecords.get(object);

  if (record === undefined) {
    throw new TypeError("Expected a VM object created by the object model.");
  }

  return record;
}

function assertPrototype(prototype: VMObject | null): void {
  if (prototype !== null && !isVMObject(prototype)) {
    throw new TypeError("VM object prototypes must be VM object references or null.");
  }
}

function assertPropertyKey(key: VMPropertyKey): void {
  if (typeof key !== "string" && !isVMSymbol(key)) {
    throw new TypeError("VM object property keys must be strings or symbols.");
  }
}

function getPropertyRecord(object: VMObject, key: VMPropertyKey): VMPropertyRecord | undefined {
  const record = getObjectRecord(object);
  const ownDescriptor = record.properties.get(key);

  if (ownDescriptor !== undefined) {
    return ownDescriptor;
  }

  return record.prototype === null ? undefined : getPropertyRecord(record.prototype, key);
}

function defineOrdinaryOwnProperty(
  record: VMObjectRecord,
  key: VMPropertyKey,
  descriptor: VMPropertyDescriptorInput,
): boolean {
  const current = record.properties.get(key);
  const normalized = normalizePropertyDescriptor(descriptor);
  const next = validateAndApplyPropertyDescriptor(current, record.extensible, normalized);

  if (next === false) {
    return false;
  }

  record.properties.set(key, next);
  return true;
}

function defineArrayProperty(
  object: VMObject,
  record: VMObjectRecord,
  key: VMPropertyKey,
  descriptor: VMPropertyDescriptorInput,
): boolean {
  if (key === "length") {
    return defineArrayLengthProperty(object, record, descriptor);
  }

  if (!isArrayIndex(key)) {
    return defineOrdinaryOwnProperty(record, key, descriptor);
  }

  const length = getArrayLength(record);
  const index = Number(key);

  if (index >= length && !isArrayLengthWritable(record)) {
    return false;
  }

  if (!defineOrdinaryOwnProperty(record, key, descriptor)) {
    return false;
  }

  if (index >= length) {
    defineArrayLength(object, index + 1, isArrayLengthWritable(record));
  }

  return true;
}

function defineArrayLengthProperty(
  object: VMObject,
  record: VMObjectRecord,
  descriptor: VMPropertyDescriptorInput,
): boolean {
  const normalized = normalizePropertyDescriptor(descriptor);

  if (normalized.kind === "accessor" || normalized.hasGet || normalized.hasSet) {
    return false;
  }

  if (!normalized.hasValue) {
    return defineOrdinaryOwnProperty(record, "length", descriptor);
  }

  const newLength = normalizeArrayLength(normalized.value);
  const oldLength = getArrayLength(record);

  if (newLength < oldLength) {
    const lengthDescriptor = record.properties.get("length");

    if (lengthDescriptor?.kind !== "data" || !lengthDescriptor.writable) {
      return false;
    }

    for (const key of ownKeys(object)) {
      if (isArrayIndex(key) && Number(key) >= newLength && !deleteProperty(object, key)) {
        return false;
      }
    }
  }

  const lengthInput: VMDataPropertyDescriptorInput = {
    configurable: false,
    enumerable: false,
    kind: "data",
    value: newLength,
    writable: normalized.hasWritable ? normalized.writable : isArrayLengthWritable(record),
  };

  return defineOrdinaryOwnProperty(record, "length", lengthInput);
}

function defineArrayLength(object: VMObject, value: number, writable: boolean): void {
  const record = getObjectRecord(object);
  record.properties.set("length", {
    configurable: false,
    enumerable: false,
    kind: "data",
    value,
    writable,
  });
}

function getArrayLength(record: VMObjectRecord): number {
  const descriptor = record.properties.get("length");

  if (descriptor?.kind !== "data" || typeof descriptor.value !== "number") {
    return 0;
  }

  return descriptor.value;
}

function isArrayLengthWritable(record: VMObjectRecord): boolean {
  const descriptor = record.properties.get("length");
  return descriptor?.kind === "data" ? descriptor.writable : true;
}

function setProperty(
  object: VMObject,
  receiver: VMObject,
  key: VMPropertyKey,
  value: unknown,
): boolean {
  const record = getObjectRecord(object);
  const descriptor = record.properties.get(key);

  if (descriptor === undefined) {
    if (record.prototype !== null) {
      return setProperty(record.prototype, receiver, key, value);
    }

    return createDataProperty(receiver, key, value);
  }

  if (descriptor.kind === "accessor") {
    return descriptor.set !== null;
  }

  if (!descriptor.writable) {
    return false;
  }

  const receiverRecord = getObjectRecord(receiver);
  const receiverDescriptor = receiverRecord.properties.get(key);

  if (receiverDescriptor !== undefined) {
    if (receiverDescriptor.kind === "accessor" || !receiverDescriptor.writable) {
      return false;
    }

    return defineOwnProperty(receiver, key, { kind: "data", value });
  }

  return createDataProperty(receiver, key, value);
}

function createDataProperty(object: VMObject, key: VMPropertyKey, value: unknown): boolean {
  if (!isExtensible(object)) {
    return false;
  }

  return defineOwnProperty(object, key, {
    configurable: true,
    enumerable: true,
    kind: "data",
    value,
    writable: true,
  });
}

function validateAndApplyPropertyDescriptor(
  current: VMPropertyRecord | undefined,
  extensible: boolean,
  descriptor: NormalizedPropertyDescriptor,
): VMPropertyRecord | false {
  if (current === undefined) {
    return extensible ? createPropertyRecord(descriptor) : false;
  }

  const descriptorKind = getDescriptorKind(descriptor, current.kind);

  if (!current.configurable) {
    if (descriptor.configurable === true) {
      return false;
    }

    if (descriptor.hasEnumerable && descriptor.enumerable !== current.enumerable) {
      return false;
    }

    if (descriptorKind !== current.kind) {
      return false;
    }

    if (current.kind === "data") {
      if (!current.writable && descriptor.writable === true) {
        return false;
      }

      if (!current.writable && descriptor.hasValue && !Object.is(descriptor.value, current.value)) {
        return false;
      }
    } else {
      if (descriptor.hasGet && descriptor.get !== current.get) {
        return false;
      }

      if (descriptor.hasSet && descriptor.set !== current.set) {
        return false;
      }
    }
  }

  return updatePropertyRecord(current, descriptor, descriptorKind);
}

function createPropertyRecord(descriptor: NormalizedPropertyDescriptor): VMPropertyRecord {
  if (getDescriptorKind(descriptor, "data") === "accessor") {
    return {
      configurable: descriptor.configurable ?? false,
      enumerable: descriptor.enumerable ?? false,
      get: descriptor.hasGet ? (descriptor.get ?? null) : null,
      kind: "accessor",
      set: descriptor.hasSet ? (descriptor.set ?? null) : null,
    };
  }

  return {
    configurable: descriptor.configurable ?? false,
    enumerable: descriptor.enumerable ?? false,
    kind: "data",
    value: descriptor.hasValue ? descriptor.value : undefined,
    writable: descriptor.writable ?? false,
  };
}

function updatePropertyRecord(
  current: VMPropertyRecord,
  descriptor: NormalizedPropertyDescriptor,
  descriptorKind: "data" | "accessor",
): VMPropertyRecord {
  const configurable = descriptor.hasConfigurable
    ? descriptor.configurable === true
    : current.configurable;
  const enumerable = descriptor.hasEnumerable ? descriptor.enumerable === true : current.enumerable;

  if (descriptorKind === "accessor") {
    return {
      configurable,
      enumerable,
      get: descriptor.hasGet
        ? (descriptor.get ?? null)
        : current.kind === "accessor"
          ? current.get
          : null,
      kind: "accessor",
      set: descriptor.hasSet
        ? (descriptor.set ?? null)
        : current.kind === "accessor"
          ? current.set
          : null,
    };
  }

  return {
    configurable,
    enumerable,
    kind: "data",
    value: descriptor.hasValue
      ? descriptor.value
      : current.kind === "data"
        ? current.value
        : undefined,
    writable: descriptor.hasWritable
      ? descriptor.writable === true
      : current.kind === "data"
        ? current.writable
        : false,
  };
}

function getDescriptorKind(
  descriptor: NormalizedPropertyDescriptor,
  fallback: "data" | "accessor",
): "data" | "accessor" {
  if (descriptor.kind !== undefined) {
    return descriptor.kind;
  }

  if (descriptor.hasGet || descriptor.hasSet) {
    return "accessor";
  }

  if (descriptor.hasValue || descriptor.hasWritable) {
    return "data";
  }

  return fallback;
}

function normalizePropertyDescriptor(
  descriptor: VMPropertyDescriptorInput,
): NormalizedPropertyDescriptor {
  if (typeof descriptor !== "object" || descriptor === null) {
    throw new TypeError("Property descriptors must be objects.");
  }

  const hasValue = hasOwn.call(descriptor, "value");
  const hasWritable = hasOwn.call(descriptor, "writable");
  const hasGet = hasOwn.call(descriptor, "get");
  const hasSet = hasOwn.call(descriptor, "set");
  const dataDescriptor = descriptor.kind === "data" || hasValue || hasWritable;
  const accessorDescriptor = descriptor.kind === "accessor" || hasGet || hasSet;

  if (dataDescriptor && accessorDescriptor) {
    throw new TypeError("Property descriptors cannot mix data and accessor fields.");
  }

  const getter = hasGet ? descriptor.get : undefined;
  const setter = hasSet ? descriptor.set : undefined;

  if (getter !== undefined && getter !== null && !isVMCallableReference(getter)) {
    throw new TypeError("Accessor getters must be VM callable references, null, or undefined.");
  }

  if (setter !== undefined && setter !== null && !isVMCallableReference(setter)) {
    throw new TypeError("Accessor setters must be VM callable references, null, or undefined.");
  }

  return {
    configurable: descriptor.configurable,
    enumerable: descriptor.enumerable,
    get: getter,
    hasConfigurable: hasOwn.call(descriptor, "configurable"),
    hasEnumerable: hasOwn.call(descriptor, "enumerable"),
    hasGet,
    hasSet,
    hasValue,
    hasWritable,
    kind: dataDescriptor ? "data" : accessorDescriptor ? "accessor" : undefined,
    set: setter,
    value: hasValue ? descriptor.value : undefined,
    writable: hasWritable ? descriptor.writable : undefined,
  };
}

function copyPropertyDescriptor(descriptor: VMPropertyRecord): VMPropertyDescriptor {
  if (descriptor.kind === "accessor") {
    const copy = Object.create(null) as VMAccessorPropertyDescriptor;

    Object.defineProperties(copy, {
      configurable: { enumerable: true, value: descriptor.configurable },
      enumerable: { enumerable: true, value: descriptor.enumerable },
      get: { enumerable: true, value: descriptor.get },
      kind: { enumerable: true, value: "accessor" },
      set: { enumerable: true, value: descriptor.set },
    });

    return Object.freeze(copy);
  }

  const copy = Object.create(null) as VMDataPropertyDescriptor;

  Object.defineProperties(copy, {
    configurable: { enumerable: true, value: descriptor.configurable },
    enumerable: { enumerable: true, value: descriptor.enumerable },
    kind: { enumerable: true, value: "data" },
    value: { enumerable: true, value: descriptor.value },
    writable: { enumerable: true, value: descriptor.writable },
  });

  return Object.freeze(copy);
}

function wouldCreatePrototypeCycle(object: VMObject, prototype: VMObject | null): boolean {
  let current = prototype;

  while (current !== null) {
    if (current === object) {
      return true;
    }

    current = getObjectRecord(current).prototype;
  }

  return false;
}

function isArrayIndex(key: VMPropertyKey): key is string {
  if (typeof key !== "string" || key.length === 0) {
    return false;
  }

  const index = Number(key);

  return Number.isInteger(index) && index >= 0 && index < maxArrayLength && String(index) === key;
}

function normalizeArrayLength(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > maxArrayLength
  ) {
    throw new RangeError("Array-like length must be an integer between 0 and 2^32 - 1.");
  }

  return value;
}
