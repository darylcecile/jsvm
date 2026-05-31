import { VMError, VMErrorCode } from "./boundary";

export type VMModuleData =
  | undefined
  | null
  | boolean
  | number
  | string
  | readonly VMModuleData[]
  | { readonly [key: string]: VMModuleData };

export interface VMModuleResolveRequest {
  readonly specifier: string;
  readonly referrer?: string;
  readonly attributes?: VMModuleData;
}

export interface VMModuleLoadRequest {
  readonly specifier: string;
  readonly referrer?: string;
  readonly attributes?: VMModuleData;
}

export interface VMModuleResolutionInput {
  readonly specifier: string;
  readonly referrer?: string;
  readonly attributes?: VMModuleData;
}

export interface VMModuleResolution {
  readonly type: "module-resolution";
  readonly specifier: string;
  readonly referrer?: string;
  readonly attributes?: VMModuleData;
}

export interface VMModuleSourceInput {
  readonly specifier?: string;
  readonly source: string;
  readonly sourceType?: "module";
  readonly attributes?: VMModuleData;
}

export interface VMModuleSource {
  readonly type: "module-source";
  readonly specifier: string;
  readonly source: string;
  readonly sourceType: "module";
  readonly attributes?: VMModuleData;
}

export type VMModuleResolveResult = string | VMModuleResolutionInput;
export type VMModuleLoadResult = string | VMModuleSourceInput;

export type VMModuleResolveCallback = (
  request: VMModuleResolveRequest,
) => VMModuleResolveResult | Promise<VMModuleResolveResult>;

export type VMModuleLoadCallback = (
  request: VMModuleLoadRequest,
) => VMModuleLoadResult | Promise<VMModuleLoadResult>;

export interface VMModuleLoader {
  readonly resolve?: VMModuleResolveCallback;
  readonly load?: VMModuleLoadCallback;
}

export interface VMNormalizedModuleLoader {
  resolve(request: VMModuleResolveRequest): Promise<VMModuleResolution>;
  load(request: VMModuleLoadRequest): Promise<VMModuleSource>;
}

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;

const DEFAULT_DENY_MODULE_LOADER: VMNormalizedModuleLoader = Object.freeze({
  resolve: async (request: VMModuleResolveRequest) => {
    const normalized = normalizeModuleResolveRequest(request);
    throw moduleDenied("resolve", normalized.specifier);
  },
  load: async (request: VMModuleLoadRequest) => {
    const normalized = normalizeModuleLoadRequest(request);
    throw moduleDenied("load", normalized.specifier);
  },
});

export function createDefaultDenyModuleLoader(): VMNormalizedModuleLoader {
  return DEFAULT_DENY_MODULE_LOADER;
}

export function normalizeModuleLoader(
  loader: VMModuleLoader | undefined,
): VMNormalizedModuleLoader {
  if (loader === undefined) {
    return createDefaultDenyModuleLoader();
  }

  if (!isPlainObject(loader)) {
    throw new VMError(
      VMErrorCode.VMSecurityError,
      "VM moduleLoader must be a plain object with explicit resolve/load callbacks.",
      { reason: "invalid module loader", valueType: typeof loader },
    );
  }

  for (const key of Object.keys(loader)) {
    if (key !== "resolve" && key !== "load") {
      throw new VMError(VMErrorCode.VMSecurityError, `Unknown VM moduleLoader option "${key}".`, {
        reason: "invalid module loader option",
        path: key,
      });
    }
  }

  const resolve = loader.resolve;
  const load = loader.load;

  if (resolve !== undefined && typeof resolve !== "function") {
    throw new VMError(
      VMErrorCode.VMSecurityError,
      "VM moduleLoader.resolve must be a function when provided.",
      { reason: "invalid module resolver", path: "resolve" },
    );
  }

  if (load !== undefined && typeof load !== "function") {
    throw new VMError(
      VMErrorCode.VMSecurityError,
      "VM moduleLoader.load must be a function when provided.",
      { reason: "invalid module loader", path: "load" },
    );
  }

  return Object.freeze({
    resolve: async (request: VMModuleResolveRequest) => {
      const normalizedRequest = normalizeModuleResolveRequest(request);

      if (resolve === undefined) {
        throw moduleDenied("resolve", normalizedRequest.specifier);
      }

      return normalizeModuleResolution(await resolve(normalizedRequest));
    },
    load: async (request: VMModuleLoadRequest) => {
      const normalizedRequest = normalizeModuleLoadRequest(request);

      if (load === undefined) {
        throw moduleDenied("load", normalizedRequest.specifier);
      }

      return normalizeModuleSource(await load(normalizedRequest), normalizedRequest.specifier);
    },
  });
}

export function normalizeModuleResolveRequest(
  request: VMModuleResolveRequest,
): VMModuleResolveRequest {
  const record = assertPlainRecord(request, "module resolve request", "$");
  assertKnownKeys(record, new Set(["specifier", "referrer", "attributes"]), "$");

  const normalized = {
    specifier: normalizeModuleSpecifier(record.specifier, "$.specifier"),
    referrer: normalizeOptionalModuleSpecifier(record.referrer, "$.referrer"),
    attributes: cloneModuleData(record.attributes, "$.attributes"),
  };

  return freezeRequest(normalized);
}

export function normalizeModuleLoadRequest(request: VMModuleLoadRequest): VMModuleLoadRequest {
  const record = assertPlainRecord(request, "module load request", "$");
  assertKnownKeys(record, new Set(["specifier", "referrer", "attributes"]), "$");

  const normalized = {
    specifier: normalizeModuleSpecifier(record.specifier, "$.specifier"),
    referrer: normalizeOptionalModuleSpecifier(record.referrer, "$.referrer"),
    attributes: cloneModuleData(record.attributes, "$.attributes"),
  };

  return freezeRequest(normalized);
}

export function normalizeModuleResolution(result: VMModuleResolveResult): VMModuleResolution {
  const specifier =
    typeof result === "string"
      ? normalizeModuleSpecifier(result, "$")
      : normalizeModuleSpecifier(
          assertPlainRecord(result, "module resolve result", "$").specifier,
          "$.specifier",
        );

  if (typeof result === "string") {
    return Object.freeze({ type: "module-resolution" as const, specifier });
  }

  const record = assertPlainRecord(result, "module resolve result", "$");
  assertKnownKeys(record, new Set(["type", "specifier", "referrer", "attributes"]), "$");

  if (record.type !== undefined && record.type !== "module-resolution") {
    throw invalidModuleValue(
      "$.type",
      record.type,
      'Module resolver result type must be "module-resolution" when provided.',
    );
  }

  const referrer = normalizeOptionalModuleSpecifier(record.referrer, "$.referrer");
  const attributes = cloneModuleData(record.attributes, "$.attributes");

  return freezeResolution({ specifier, referrer, attributes });
}

export function normalizeModuleSource(
  result: VMModuleLoadResult,
  fallbackSpecifier: string,
): VMModuleSource {
  const fallback = normalizeModuleSpecifier(fallbackSpecifier, "fallbackSpecifier");

  if (typeof result === "string") {
    return Object.freeze({
      type: "module-source" as const,
      specifier: fallback,
      source: result,
      sourceType: "module" as const,
    });
  }

  const record = assertPlainRecord(result, "module load result", "$");
  assertKnownKeys(
    record,
    new Set(["type", "specifier", "source", "sourceType", "attributes"]),
    "$",
  );

  if (record.type !== undefined && record.type !== "module-source") {
    throw invalidModuleValue(
      "$.type",
      record.type,
      'Module loader result type must be "module-source" when provided.',
    );
  }

  if (typeof record.source !== "string") {
    throw invalidModuleValue(
      "$.source",
      record.source,
      "Module loader load results must include a source string.",
    );
  }

  if (record.sourceType !== undefined && record.sourceType !== "module") {
    throw invalidModuleValue(
      "$.sourceType",
      record.sourceType,
      'Module loader sourceType must be "module" when provided.',
    );
  }

  const specifier =
    record.specifier === undefined
      ? fallback
      : normalizeModuleSpecifier(record.specifier, "$.specifier");
  const attributes = cloneModuleData(record.attributes, "$.attributes");

  return freezeSource({ specifier, source: record.source, sourceType: "module", attributes });
}

function normalizeModuleSpecifier(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw invalidModuleValue(path, value, "Module specifiers must be strings.");
  }

  if (value.length === 0) {
    throw invalidModuleValue(path, value, "Module specifiers must not be empty.");
  }

  if (value !== value.trim()) {
    throw invalidModuleValue(
      path,
      value,
      "Module specifiers must not include surrounding whitespace.",
    );
  }

  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    throw invalidModuleValue(path, value, "Module specifiers must not include control characters.");
  }

  return value;
}

function normalizeOptionalModuleSpecifier(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return normalizeModuleSpecifier(value, path);
}

function cloneModuleData(value: unknown, path: string, seen = new WeakSet<object>()): VMModuleData {
  if (
    value === undefined ||
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    throw invalidModuleValue(
      path,
      value,
      "Module loader metadata must be plain serializable data.",
    );
  }

  if (typeof value !== "object") {
    throw invalidModuleValue(
      path,
      value,
      "Module loader metadata must be plain serializable data.",
    );
  }

  if (seen.has(value)) {
    throw new VMError(VMErrorCode.BoundaryCycle, `Cycle detected at ${path}.`, {
      path,
      valueType: describeValue(value),
      reason: "cycle",
    });
  }

  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return freezeModuleArray(value, path, seen);
    }

    if (!isPlainObject(value)) {
      throw invalidModuleValue(
        path,
        value,
        "Module loader metadata must be plain serializable data.",
      );
    }

    return freezeModuleRecord(value, path, seen);
  } finally {
    seen.delete(value);
  }
}

function freezeModuleArray(
  value: readonly unknown[],
  path: string,
  seen: WeakSet<object>,
): readonly VMModuleData[] {
  const descriptors = Object.getOwnPropertyDescriptors(value);

  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw invalidModuleValue(path, value, "Module loader arrays cannot include symbols.");
  }

  for (const key of Object.keys(descriptors)) {
    if (key === "length" || isArrayIndex(key)) {
      continue;
    }

    throw invalidModuleValue(
      `${path}.${key}`,
      value,
      "Module loader arrays cannot include custom properties.",
    );
  }

  const output: VMModuleData[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];

    if (descriptor === undefined) {
      output[index] = undefined;
      continue;
    }

    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      throw invalidModuleValue(
        `${path}[${index}]`,
        value,
        "Module loader array entries must be enumerable data properties.",
      );
    }

    output[index] = cloneModuleData(descriptor.value, `${path}[${index}]`, seen);
  }

  return Object.freeze(output);
}

function freezeModuleRecord(
  value: object,
  path: string,
  seen: WeakSet<object>,
): Readonly<Record<string, VMModuleData>> {
  const descriptors = Object.getOwnPropertyDescriptors(value);

  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw invalidModuleValue(path, value, "Module loader records cannot include symbols.");
  }

  const output = Object.create(null) as Record<string, VMModuleData>;

  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      throw invalidModuleValue(
        `${path}.${key}`,
        value,
        "Module loader record properties must be enumerable data properties.",
      );
    }

    output[key] = cloneModuleData(descriptor.value, `${path}.${key}`, seen);
  }

  return Object.freeze(output);
}

function freezeRequest<T extends VMModuleResolveRequest | VMModuleLoadRequest>(request: T): T {
  const output = Object.create(null) as Record<string, VMModuleData | string>;
  output.specifier = request.specifier;

  if (request.referrer !== undefined) {
    output.referrer = request.referrer;
  }

  if (request.attributes !== undefined) {
    output.attributes = request.attributes;
  }

  return Object.freeze(output) as unknown as T;
}

function freezeResolution(resolution: Omit<VMModuleResolution, "type">): VMModuleResolution {
  const output = Object.create(null) as Record<string, VMModuleData | string>;
  output.type = "module-resolution";
  output.specifier = resolution.specifier;

  if (resolution.referrer !== undefined) {
    output.referrer = resolution.referrer;
  }

  if (resolution.attributes !== undefined) {
    output.attributes = resolution.attributes;
  }

  return Object.freeze(output) as unknown as VMModuleResolution;
}

function freezeSource(source: Omit<VMModuleSource, "type">): VMModuleSource {
  const output = Object.create(null) as Record<string, VMModuleData | string>;
  output.type = "module-source";
  output.specifier = source.specifier;
  output.source = source.source;
  output.sourceType = source.sourceType;

  if (source.attributes !== undefined) {
    output.attributes = source.attributes;
  }

  return Object.freeze(output) as unknown as VMModuleSource;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalidModuleValue(
        `${path}.${key}`,
        value[key],
        `Unknown module loader field "${key}".`,
      );
    }
  }
}

function assertPlainRecord(value: unknown, label: string, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw invalidModuleValue(path, value, `VM ${label} must be a plain object.`);
  }

  return value;
}

function moduleDenied(operation: "resolve" | "load", specifier: string): VMError {
  return new VMError(
    VMErrorCode.VMSecurityError,
    `VM module ${operation} denied for "${specifier}".`,
    { path: specifier, reason: "module loader denied" },
  );
}

function invalidModuleValue(path: string, value: unknown, reason: string): VMError {
  return new VMError(VMErrorCode.BoundaryUnsupportedType, reason, {
    path,
    valueType: describeValue(value),
    reason: "invalid module loader data",
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isArrayIndex(key: string): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 2 ** 32 - 1 && String(index) === key;
}

function describeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  return typeof value;
}
