import {
  createCapability,
  invokeBoundaryCapability,
  isVMCapability,
  type CreateVMCapabilityOptions,
  type VMBoundaryValue,
  type VMCapability,
  type VMCapabilityHandler,
  type VMCapabilityMetadata,
  type VMSerializablePrimitive,
  type VMSerializableValue,
} from "../boundary";

export type VMGuestPrimitive = VMSerializablePrimitive;
export type VMGuestValue =
  | VMGuestPrimitive
  | VMGuestCallable
  | readonly VMGuestValue[]
  | { readonly [key: string]: VMGuestValue };

export interface VMGuestCallable {
  readonly kind: "host-callable";
  readonly metadata: VMCapabilityMetadata;
}

export interface VMNativeCallable {
  readonly kind: "native-callable";
  readonly metadata: VMCapabilityMetadata;
  readonly constructable: boolean;
}

export interface VMSymbol {
  readonly kind: "vm-symbol";
  readonly id: number;
  readonly description?: string;
  readonly registryKey?: string;
  readonly wellKnownName?: string;
}

export interface VMNativeCallableTools {
  invokeGuestCallable(callable: unknown, args: readonly unknown[]): Promise<unknown>;
}

export type VMNativeCallableHandler = (
  args: readonly unknown[],
  context: unknown,
  thisValue: unknown,
  tools: VMNativeCallableTools,
) => unknown | Promise<unknown>;

export interface CreateVMNativeCallableOptions extends CreateVMCapabilityOptions {
  readonly construct?: VMNativeCallableHandler;
}

interface HostCallableRecord {
  readonly capability: VMCapability;
}

interface NativeCallableRecord {
  readonly call: VMNativeCallableHandler;
  readonly construct?: VMNativeCallableHandler;
}

const hostCallableRecords = new WeakMap<VMGuestCallable, HostCallableRecord>();
const nativeCallableRecords = new WeakMap<VMNativeCallable, NativeCallableRecord>();
const vmSymbolRecords = new WeakSet<VMSymbol>();
let nextSymbolId = 1;

export function createVMSymbol(
  description?: string,
  options: { readonly registryKey?: string; readonly wellKnownName?: string } = {},
): VMSymbol {
  const symbol = Object.create(null) as VMSymbol;

  Object.defineProperties(symbol, {
    kind: {
      enumerable: true,
      value: "vm-symbol",
    },
    id: {
      enumerable: true,
      value: nextSymbolId++,
    },
  });

  if (description !== undefined) {
    Object.defineProperty(symbol, "description", {
      enumerable: true,
      value: description,
    });
  }

  if (options.registryKey !== undefined) {
    Object.defineProperty(symbol, "registryKey", {
      enumerable: true,
      value: options.registryKey,
    });
  }

  if (options.wellKnownName !== undefined) {
    Object.defineProperty(symbol, "wellKnownName", {
      enumerable: true,
      value: options.wellKnownName,
    });
  }

  vmSymbolRecords.add(symbol);
  return Object.freeze(symbol);
}

export function isVMSymbol(value: unknown): value is VMSymbol {
  return typeof value === "object" && value !== null && vmSymbolRecords.has(value as VMSymbol);
}

export function describeVMSymbol(symbol: VMSymbol): string {
  return `Symbol(${symbol.description ?? ""})`;
}

export function createHostCallable(
  name: string,
  handler: VMCapabilityHandler,
  options?: CreateVMCapabilityOptions,
): VMGuestCallable;
export function createHostCallable(
  name: string,
  capability: VMCapability,
): VMGuestCallable;
export function createHostCallable(
  name: string,
  handlerOrCapability: VMCapabilityHandler | VMCapability,
  options: CreateVMCapabilityOptions = {},
): VMGuestCallable {
  const capability = isVMCapability(handlerOrCapability)
    ? handlerOrCapability
    : createCapability(name, handlerOrCapability, options);
  const callable = Object.create(null) as VMGuestCallable;

  Object.defineProperties(callable, {
    kind: {
      enumerable: true,
      value: "host-callable",
    },
    metadata: {
      enumerable: true,
      value: copyCapabilityMetadata(capability.metadata),
    },
  });

  hostCallableRecords.set(callable, { capability });

  return Object.freeze(callable);
}

function copyCapabilityMetadata(metadata: VMCapabilityMetadata): VMCapabilityMetadata {
  const copy = Object.create(null) as {
    id: string;
    name: string;
    arity?: number;
    description?: string;
  };

  copy.id = metadata.id;
  copy.name = metadata.name;

  if (metadata.arity !== undefined) {
    copy.arity = metadata.arity;
  }

  if (metadata.description !== undefined) {
    copy.description = metadata.description;
  }

  return Object.freeze(copy);
}

export function isHostCallable(value: unknown): value is VMGuestCallable {
  return typeof value === "object" && value !== null && hostCallableRecords.has(value as VMGuestCallable);
}

export function createNativeCallable(
  name: string,
  call: VMNativeCallableHandler,
  options: CreateVMNativeCallableOptions = {},
): VMNativeCallable {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("Native callable names must be non-empty strings.");
  }

  if (typeof call !== "function") {
    throw new TypeError("Native callable handlers must be functions.");
  }

  if (options.construct !== undefined && typeof options.construct !== "function") {
    throw new TypeError("Native callable construct handlers must be functions.");
  }

  const callable = Object.create(null) as VMNativeCallable;
  const metadata = copyCapabilityMetadata({
    id: options.id ?? `native:${name}`,
    name,
    arity: options.arity ?? call.length,
    description: options.description,
  });

  Object.defineProperties(callable, {
    kind: {
      enumerable: true,
      value: "native-callable",
    },
    metadata: {
      enumerable: true,
      value: metadata,
    },
    constructable: {
      enumerable: true,
      value: options.construct !== undefined,
    },
  });

  nativeCallableRecords.set(callable, {
    call,
    construct: options.construct,
  });

  return Object.freeze(callable);
}

export function isNativeCallable(value: unknown): value is VMNativeCallable {
  return typeof value === "object" && value !== null && nativeCallableRecords.has(value as VMNativeCallable);
}

export async function invokeHostCallable(
  callable: VMGuestCallable,
  args: readonly unknown[],
): Promise<VMSerializableValue> {
  const record = hostCallableRecords.get(callable);

  if (record === undefined) {
    throw new TypeError("Expected a VM guest callable created by createHostCallable().");
  }

  return invokeBoundaryCapability(record.capability, args);
}

export async function invokeNativeCallable(
  callable: VMNativeCallable,
  args: readonly unknown[],
  context: unknown,
  thisValue: unknown,
  tools: VMNativeCallableTools,
): Promise<unknown> {
  const record = nativeCallableRecords.get(callable);

  if (record === undefined) {
    throw new TypeError("Expected a VM native callable created by createNativeCallable().");
  }

  return record.call(args, context, thisValue, tools);
}

export async function constructNativeCallable(
  callable: VMNativeCallable,
  args: readonly unknown[],
  context: unknown,
  tools: VMNativeCallableTools,
): Promise<unknown> {
  const record = nativeCallableRecords.get(callable);

  if (record === undefined || record.construct === undefined) {
    throw new TypeError("Expected a constructable VM native callable.");
  }

  return record.construct(args, context, undefined, tools);
}

export function revokeHostCallable(callable: VMGuestCallable): void {
  const record = hostCallableRecords.get(callable);

  if (record === undefined) {
    throw new TypeError("Expected a VM guest callable created by createHostCallable().");
  }

  record.capability.revoke();
}

export type VMHostCallableHandler = (
  ...args: VMSerializableValue[]
) => VMBoundaryValue | Promise<VMBoundaryValue>;
