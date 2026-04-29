import {
  VMError,
  VMErrorCode,
  createCapability,
  invokeBoundaryCapability,
  isVMCapability,
  reconstructBoundaryValue,
  serializeAndReconstructBoundaryValue,
  type VMBoundaryValue,
  type VMCapability,
  type VMCapabilityHandler,
  type VMSerializableValue,
  type VMSerializedValue,
} from "./boundary";
import {
  createEvaluatorContext,
  evaluateProgram,
  serializeGuestValueForSnapshot,
} from "./interpreter/evaluator";
import { createExecutionContext, type VMExecutionContext } from "./interpreter/runtime";
import { createHostCallable, type VMGuestCallable } from "./interpreter/values";
import type {
  NetworkRuleBuilder,
  NetworkRuleDefinition,
} from "./network-rule";
import { createNetworkGlobals } from "./networking";
import { parseProgram } from "./parser";

export interface VMExecutionRules {
  /**
   * Best-effort wall-clock guard in milliseconds.
   *
   * Browser-compatible JavaScript cannot synchronously preempt arbitrary code, so
   * this is checked cooperatively by the VM interpreter. It is not a hard CPU
   * isolation guarantee.
   */
  readonly timeLimit?: number;
}

export interface VMNumbersConfig {
  readonly randomSeed?: string | number;
  readonly dateNow?: number;
}

export interface VMCapabilities {
  readonly executionRules?: VMExecutionRules;
  readonly numbers?: VMNumbersConfig;
  readonly networkingRules?: readonly VMNetworkRuleInput[];
}

export type VMNetworkRuleInput = NetworkRuleDefinition | NetworkRuleBuilder;

export type VMHostCallable = (
  ...args: VMSerializableValue[]
) => VMBoundaryValue | Promise<VMBoundaryValue>;

export type VMGlobalValue =
  | VMBoundaryValue
  | VMHostCallable
  | readonly VMGlobalValue[]
  | { readonly [key: string]: VMGlobalValue };

export type VMGlobals = Readonly<Record<string, VMGlobalValue>>;

export interface VMOptions {
  readonly capabilities?: VMCapabilities;
  readonly globals?: VMGlobals;
  readonly executionRules?: VMExecutionRules;
  readonly numbers?: VMNumbersConfig;
}

export interface VMEvaluateOptions {
  readonly timeLimit?: number;
}

export interface VMSuccessResult<T = VMSerializableValue> {
  readonly ok: true;
  readonly value: T;
}

export interface VMFailureResult {
  readonly ok: false;
  readonly error: VMError;
}

export type VMResult<T = VMSerializableValue> =
  | VMSuccessResult<T>
  | VMFailureResult;

export interface VMSnapshot {
  readonly version: 1;
  readonly started: boolean;
  readonly options: {
    readonly capabilities: {
      readonly executionRules?: VMExecutionRules;
      readonly numbers?: VMNumbersConfig;
      readonly networkingRules?: readonly NetworkRuleDefinition[];
    };
  };
  readonly state: readonly (readonly [string, VMSerializedValue])[];
}

type VMState = "created" | "started" | "disposed";

interface InstalledCapability {
  readonly name: string;
  readonly capability: VMCapability;
}

const SNAPSHOT_EXCLUDED_GLOBALS = new Set<string>([
  "undefined",
  "NaN",
  "Infinity",
  "Math",
  "Date",
  "JSON",
  "Object",
  "Array",
  "Number",
  "String",
  "Boolean",
  "BigInt",
  "fetch",
  "XMLHttpRequest",
]);

export class VM {
  readonly options: VMOptions;

  #state: VMState = "created";
  #context?: VMExecutionContext;
  #installedCapabilities: InstalledCapability[] = [];
  #networkingRules: readonly NetworkRuleDefinition[];
  #executionRules: VMExecutionRules;
  #numbers: VMNumbersConfig;
  #initialGlobals: VMGlobals;
  #restoredState?: readonly (readonly [string, VMSerializedValue])[];

  constructor(options: VMOptions = {}) {
    this.options = cloneOptions(options);
    this.#executionRules = Object.freeze({
      ...options.capabilities?.executionRules,
      ...options.executionRules,
    });
    this.#numbers = Object.freeze({
      ...options.capabilities?.numbers,
      ...options.numbers,
    });
    this.#networkingRules = Object.freeze(
      (options.capabilities?.networkingRules ?? []).map(normalizeNetworkRule),
    );
    this.#initialGlobals = options.globals ?? {};
  }

  static fromSnapshot(snapshot: VMSnapshot): VM {
    assertValidSnapshot(snapshot);

    const vm = new VM({
      capabilities: {
        executionRules: snapshot.options.capabilities.executionRules,
        numbers: snapshot.options.capabilities.numbers,
        networkingRules: snapshot.options.capabilities.networkingRules,
      },
    });

    vm.#restoredState = snapshot.state;
    vm.#initializeContext(true);
    vm.#state = snapshot.started ? "started" : "created";
    return vm;
  }

  async start(): Promise<void> {
    this.#assertNotDisposed();

    if (this.#state === "started") {
      return;
    }

    this.#initializeContext(true);
    this.#state = "started";
  }

  dispose(): void {
    if (this.#state === "disposed") {
      return;
    }

    for (const installed of this.#installedCapabilities) {
      installed.capability.revoke();
    }

    this.#installedCapabilities = [];
    this.#context = undefined;
    this.#state = "disposed";
  }

  async idle(): Promise<void> {
    this.#assertUsable();
    await Promise.resolve();
    await Promise.resolve();
  }

  reset(): void {
    this.#assertNotDisposed();
    this.#initializeContext(false);
    this.#state = "started";
  }

  snapshot(): VMSnapshot {
    this.#assertUsable();

    if (this.#installedCapabilities.length > 0) {
      throw new VMError(
        VMErrorCode.VMSnapshotUnsupported,
        "Cannot snapshot a VM with host capabilities or callable globals.",
        {
          reason: this.#installedCapabilities
            .map((installed) => installed.name)
            .join(", "),
        },
      );
    }

    const context = this.#getContext();
    const state: (readonly [string, VMSerializedValue])[] = [];

    try {
      for (const name of context.globalEnvironment.getOwnBindingNames()) {
        if (SNAPSHOT_EXCLUDED_GLOBALS.has(name)) {
          continue;
        }

        state.push([
          name,
          serializeGuestValueForSnapshot(context.globalEnvironment.get(name)),
        ] as const);
      }
    } catch (error) {
      throw snapshotUnsupportedError(error);
    }

    return Object.freeze({
      version: 1 as const,
      started: this.#state === "started",
      options: Object.freeze({
        capabilities: Object.freeze({
          executionRules: this.#executionRules,
          numbers: this.#numbers,
          networkingRules: this.#networkingRules,
        }),
      }),
      state: Object.freeze(state),
    });
  }

  async eval(
    source: string,
    options: VMEvaluateOptions = {},
  ): Promise<VMResult> {
    return this.evaluate(source, options);
  }

  async evaluate(
    source: string,
    options: VMEvaluateOptions = {},
  ): Promise<VMResult> {
    this.#assertUsable();

    if (typeof source !== "string") {
      return failure(
        new VMError(
          VMErrorCode.VMSyntaxError,
          "VM source must be a string.",
          { valueType: typeof source },
        ),
      );
    }

    try {
      const timeLimit = normalizeTimeLimit(
        options.timeLimit ?? this.#executionRules.timeLimit,
      );
      const baseContext = this.#getContext();
      const evaluationContext = createExecutionContext({
        globalEnvironment: baseContext.globalEnvironment,
        lexicalEnvironment: baseContext.globalEnvironment,
        variableEnvironment: baseContext.globalEnvironment,
        budget: { timeLimitMs: timeLimit },
      });
      const program = parseProgram(source);
      const value = await evaluateProgram(program, { context: evaluationContext });

      return success(value);
    } catch (error) {
      return failure(toVMError(error));
    }
  }

  #initializeContext(includeRestoredState: boolean): void {
    for (const installed of this.#installedCapabilities) {
      installed.capability.revoke();
    }

    this.#installedCapabilities = [];
    const globals = this.#createInitialContextGlobals(includeRestoredState);
    this.#context = createEvaluatorContext({ globals });
  }

  #createInitialContextGlobals(includeRestoredState: boolean): Readonly<Record<string, unknown>> {
    const globals = Object.create(null) as Record<string, unknown>;
    installBaseGlobals(globals, this.#numbers, this.#networkingRules);

    for (const [name, value] of Object.entries(this.#initialGlobals)) {
      assertSafeGlobalName(name);
      globals[name] = this.#prepareGlobalValue(value, name);
    }

    if (includeRestoredState && this.#restoredState !== undefined) {
      for (const [name, value] of this.#restoredState) {
        assertSafeGlobalName(name);
        globals[name] = reconstructBoundaryValue(value);
      }
    }

    return globals;
  }

  #prepareGlobalValue(value: VMGlobalValue, path: string): unknown {
    if (typeof value === "function") {
      return this.#installCapability(path, value as VMCapabilityHandler);
    }

    if (isVMCapability(value)) {
      return this.#installCapability(path, (...args) =>
        invokeBoundaryCapability(value, args),
      );
    }

    if (
      (Array.isArray(value) || isPlainObject(value)) &&
      !containsGlobalCapability(value, new WeakSet<object>())
    ) {
      return serializeAndReconstructBoundaryValue(value, {
        allowCapabilities: false,
      });
    }

    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const output: unknown[] = [];

      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new VMError(
          VMErrorCode.VMSecurityError,
          `VM global "${path}" cannot include symbol properties.`,
        );
      }

      for (const key of Object.keys(descriptors)) {
        if (key === "length") {
          continue;
        }

        if (!isArrayIndex(key)) {
          throw new VMError(
            VMErrorCode.VMSecurityError,
            `VM global "${path}" array cannot include custom properties.`,
          );
        }
      }

      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined) {
          output[index] = undefined;
          continue;
        }

        if (!("value" in descriptor)) {
          throw new VMError(
            VMErrorCode.VMSecurityError,
            `VM global "${path}[${index}]" cannot be an accessor property.`,
          );
        }

        output[index] = this.#prepareGlobalValue(
          descriptor.value as VMGlobalValue,
          `${path}[${index}]`,
        );
      }

      return output;
    }

    if (isPlainObject(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const output = Object.create(null) as Record<string, unknown>;

      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new VMError(
          VMErrorCode.VMSecurityError,
          `VM global "${path}" cannot include symbol properties.`,
        );
      }

      for (const [key, descriptor] of Object.entries(descriptors)) {
        assertSafePropertyName(key, `${path}.${key}`);

        if (!descriptor.enumerable) {
          throw new VMError(
            VMErrorCode.VMSecurityError,
            `VM global "${path}.${key}" must be enumerable.`,
          );
        }

        if (!("value" in descriptor)) {
          throw new VMError(
            VMErrorCode.VMSecurityError,
            `VM global "${path}.${key}" cannot be an accessor property.`,
          );
        }

        output[key] = this.#prepareGlobalValue(
          descriptor.value as VMGlobalValue,
          `${path}.${key}`,
        );
      }
      return output;
    }

    return serializeAndReconstructBoundaryValue(value, { allowCapabilities: false });
  }

  #installCapability(name: string, handler: VMCapabilityHandler): VMGuestCallable {
    const capability = createCapability(name, handler);
    this.#installedCapabilities.push({ name, capability });
    return createHostCallable(name, capability);
  }

  #getContext(): VMExecutionContext {
    if (this.#context === undefined) {
      throw new VMError(
        VMErrorCode.VMNotStarted,
        "VM.start() must be called before using this VM.",
      );
    }

    return this.#context;
  }

  #assertUsable(): void {
    this.#assertNotDisposed();

    if (this.#state !== "started") {
      throw new VMError(
        VMErrorCode.VMNotStarted,
        "VM.start() must be called before using this VM.",
      );
    }
  }

  #assertNotDisposed(): void {
    if (this.#state === "disposed") {
      throw new VMError(VMErrorCode.VMDisposed, "This VM has been disposed.");
    }
  }
}

function installBaseGlobals(
  target: Record<string, unknown>,
  numbers: VMNumbersConfig,
  networkingRules: readonly NetworkRuleDefinition[],
): void {
  target.undefined = undefined;
  target.NaN = NaN;
  target.Infinity = Infinity;
  target.Math = createSafeMath(numbers.randomSeed);
  target.Date = createSafeDate(numbers.dateNow);
  target.JSON = createSafeJSON();
  target.Object = createSafeObject();
  target.Array = createSafeArray();
  target.Number = createHostCallable("Number", (value) => Number(value));
  target.String = createHostCallable("String", (value) => String(value));
  target.Boolean = createHostCallable("Boolean", (value) => Boolean(value));
  target.BigInt = createHostCallable("BigInt", (value) => BigInt(String(value)));
  Object.assign(target, createNetworkGlobals(networkingRules));
}

function createSafeMath(randomSeed: string | number | undefined): object {
  const rng =
    randomSeed === undefined ? () => Math.random() : createSeededRandom(randomSeed);
  const safeMath = Object.create(null) as Record<string, unknown>;

  for (const key of Object.getOwnPropertyNames(Math)) {
    const value = Math[key as keyof typeof Math];
    if (key === "random") {
      safeMath.random = createHostCallable("Math.random", () => rng());
    } else if (typeof value === "function") {
      safeMath[key] = createHostCallable(`Math.${key}`, (...args) =>
        (value as (...nextArgs: number[]) => number)(
          ...args.map((arg) => Number(arg)),
        ),
      );
    } else {
      safeMath[key] = value;
    }
  }

  return Object.freeze(safeMath);
}

function createSafeDate(dateNow: number | undefined): object {
  const now = () => dateNow ?? Date.now();
  return Object.freeze(
    Object.assign(Object.create(null), {
      now: createHostCallable("Date.now", () => now()),
      parse: createHostCallable("Date.parse", (value) =>
        Date.parse(String(value)),
      ),
      UTC: createHostCallable("Date.UTC", (...args) => dateUTC(args)),
    }),
  );
}

function dateUTC(args: readonly unknown[]): number {
  return Date.UTC(
    Number(args[0] ?? 0),
    Number(args[1] ?? 0),
    Number(args[2] ?? 1),
    Number(args[3] ?? 0),
    Number(args[4] ?? 0),
    Number(args[5] ?? 0),
    Number(args[6] ?? 0),
  );
}

function createSafeJSON(): object {
  return Object.freeze(
    Object.assign(Object.create(null), {
      parse: createHostCallable("JSON.parse", (source) =>
        JSON.parse(String(source)) as VMSerializableValue,
      ),
      stringify: createHostCallable("JSON.stringify", (value) =>
        JSON.stringify(value),
      ),
    }),
  );
}

function createSafeObject(): object {
  return Object.freeze(
    Object.assign(Object.create(null), {
      keys: createHostCallable("Object.keys", (value) =>
        Object.keys(Object(value)),
      ),
      values: createHostCallable("Object.values", (value) =>
        Object.values(Object(value)) as VMSerializableValue[],
      ),
      entries: createHostCallable("Object.entries", (value) =>
        Object.entries(Object(value)) as VMSerializableValue[],
      ),
      fromEntries: createHostCallable("Object.fromEntries", (value) =>
        Object.fromEntries(value as Iterable<readonly [PropertyKey, unknown]>) as Record<string, VMSerializableValue>,
      ),
      assign: createHostCallable("Object.assign", (target, ...sources) =>
        Object.assign(Object(target), ...sources.map((source) => Object(source))) as Record<string, VMSerializableValue>,
      ),
    }),
  );
}

function createSafeArray(): object {
  return Object.freeze(
    Object.assign(Object.create(null), {
      isArray: createHostCallable("Array.isArray", (value) =>
        Array.isArray(value),
      ),
      from: createHostCallable("Array.from", (value) =>
        Array.from(value as Iterable<unknown>) as VMSerializableValue[],
      ),
      of: createHostCallable("Array.of", (...values) => values),
    }),
  );
}

function success<T extends VMSerializableValue>(value: T): VMSuccessResult<T> {
  return Object.freeze({ ok: true, value });
}

function failure(error: VMError): VMFailureResult {
  return Object.freeze({ ok: false, error });
}

function normalizeTimeLimit(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isFinite(value) || value < 0) {
    throw new VMError(
      VMErrorCode.VMRuntimeError,
      "executionRules.timeLimit must be a non-negative finite number.",
      { valueType: typeof value },
    );
  }

  return value;
}

function normalizeNetworkRule(
  rule: VMNetworkRuleInput,
): NetworkRuleDefinition {
  const definition: NetworkRuleDefinition = isNetworkRuleBuilder(rule)
    ? rule.toJSON()
    : rule;

  return Object.freeze({
    type: definition.type,
    host: definition.host,
    allow: Object.freeze({
      methods:
        definition.allow.methods === "all" || definition.allow.methods === "none"
          ? definition.allow.methods
          : Object.freeze([...definition.allow.methods]),
      paths:
        definition.allow.paths === "all" || definition.allow.paths === "none"
          ? definition.allow.paths
          : Object.freeze([...definition.allow.paths]),
    }),
    headers: Object.freeze({ ...definition.headers }),
  });
}

function isNetworkRuleBuilder(
  rule: VMNetworkRuleInput,
): rule is NetworkRuleBuilder {
  return typeof (rule as NetworkRuleBuilder).toJSON === "function";
}

function cloneOptions(options: VMOptions): VMOptions {
  return Object.freeze({
    capabilities: options.capabilities
      ? Object.freeze({
          executionRules: options.capabilities.executionRules
            ? Object.freeze({ ...options.capabilities.executionRules })
            : undefined,
          numbers: options.capabilities.numbers
            ? Object.freeze({ ...options.capabilities.numbers })
            : undefined,
          networkingRules: options.capabilities.networkingRules
            ? Object.freeze(options.capabilities.networkingRules.map(normalizeNetworkRule))
            : undefined,
        })
      : undefined,
    globals: options.globals,
    executionRules: options.executionRules
      ? Object.freeze({ ...options.executionRules })
      : undefined,
    numbers: options.numbers ? Object.freeze({ ...options.numbers }) : undefined,
  });
}

function assertValidSnapshot(snapshot: VMSnapshot): void {
  if (
    !isPlainObject(snapshot) ||
    snapshot.version !== 1 ||
    typeof snapshot.started !== "boolean" ||
    !Array.isArray(snapshot.state) ||
    !isPlainObject(snapshot.options) ||
    !isPlainObject(snapshot.options.capabilities)
  ) {
    throw new VMError(
      VMErrorCode.VMSnapshotUnsupported,
      "Invalid VM snapshot.",
    );
  }
}

function assertSafeGlobalName(name: string): void {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
    throw new VMError(
      VMErrorCode.VMSecurityError,
      `Invalid VM global name "${name}".`,
    );
  }

}

function assertSafePropertyName(name: string, path: string): void {
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function containsGlobalCapability(value: unknown, seen: WeakSet<object>): boolean {
  if (typeof value === "function" || isVMCapability(value)) {
    return true;
  }

  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);

    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor !== undefined &&
        "value" in descriptor &&
        containsGlobalCapability(descriptor.value, seen)
      ) {
        return true;
      }
    }

    return false;
  }

  if (isPlainObject(value)) {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (
        "value" in descriptor &&
        containsGlobalCapability(descriptor.value, seen)
      ) {
        return true;
      }
    }
  }

  return false;
}

function isArrayIndex(key: string): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 2 ** 32 - 1 && String(index) === key;
}

function snapshotUnsupportedError(error: unknown): VMError {
  if (error instanceof VMError && error.code === VMErrorCode.VMSnapshotUnsupported) {
    return error;
  }

  const reason = error instanceof VMError ? error.message : String(error);
  return new VMError(
    VMErrorCode.VMSnapshotUnsupported,
    "Cannot snapshot VM state because it contains non-serializable values.",
    { reason },
  );
}

function toVMError(error: unknown): VMError {
  if (error instanceof VMError) {
    return error;
  }

  if (error instanceof SyntaxError) {
    return new VMError(VMErrorCode.VMSyntaxError, error.message);
  }

  if (error instanceof Error) {
    return new VMError(VMErrorCode.VMRuntimeError, error.message, {
      valueType: error.name,
    });
  }

  return new VMError(
    VMErrorCode.VMRuntimeError,
    `Guest evaluation failed: ${String(error)}`,
    { valueType: typeof error },
  );
}

function createSeededRandom(seed: string | number): () => number {
  let state = hashSeed(String(seed));

  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;

  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}
