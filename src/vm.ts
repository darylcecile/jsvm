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
  createDynamicCodeGlobals,
  createEvaluatorContext,
  evaluateProgram,
  exportGuestValueForHost,
  executeProgramForSideEffects,
  invokeGuestCallableForHost,
  isGuestCallableValue,
  serializeGuestValueForSnapshot,
} from "./interpreter/evaluator";
import { createLexicalEnvironment, type VMEnvironment } from "./interpreter/environment";
import {
  createOrdinaryObject,
  defineOwnProperty,
  preventExtensions,
  type VMObject,
} from "./interpreter/object-model";
import { createExecutionContext, type VMExecutionContext } from "./interpreter/runtime";
import { createHostCallable, type VMGuestCallable } from "./interpreter/values";
import type {
  NetworkRuleBuilder,
  NetworkRuleDefinition,
} from "./network-rule";
import { createNetworkGlobals, performHostNetworkRequest } from "./networking";
import {
  normalizeModuleLoader,
  type VMModuleResolution,
  type VMModuleLoader,
  type VMModuleSource,
  type VMNormalizedModuleLoader,
} from "./module-loader";
import { parseProgram, type VMParserSourceType, type VMProgram } from "./parser";

export interface VMExecutionRules {
  /**
   * Best-effort wall-clock guard in milliseconds.
   *
   * Browser-compatible JavaScript cannot synchronously preempt arbitrary code, so
   * this is checked cooperatively by the VM interpreter. It is not a hard CPU
   * isolation guarantee.
   */
  readonly timeLimit?: number;

  /**
   * Best-effort step budget for interpreter checkpoints.
   *
   * This is a cooperative guardrail, not an instruction-accurate counter.
   */
  readonly maxSteps?: number;
}

export interface VMNumbersConfig {
  readonly randomSeed?: string | number;
  readonly dateNow?: number;
}

export interface VMCapabilities {
  readonly executionRules?: VMExecutionRules;
  readonly numbers?: VMNumbersConfig;
  readonly networkingRules?: readonly VMNetworkRuleInput[];
  readonly moduleLoader?: VMModuleLoader;
  readonly dynamicCode?: boolean;
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
  readonly maxSteps?: number;
  readonly maxSteps?: number;
  readonly sourceType?: VMParserSourceType;
}

export interface VMImportOptions {
  readonly timeLimit?: number;
  readonly maxSteps?: number;
  readonly maxSteps?: number;
}

export interface VMDangerousEvaluateUrlOptions extends VMEvaluateOptions {
  readonly maxBytes?: number;
}

export interface VMDangerousAPI {
  readonly evaluateUrl: (
    url: string | URL,
    options?: VMDangerousEvaluateUrlOptions,
  ) => Promise<VMResult>;
  readonly eval: (
    url: string | URL,
    options?: VMDangerousEvaluateUrlOptions,
  ) => Promise<VMResult>;
}

export interface VMFunctionHandle {
  readonly name: string;
  call(...args: VMSerializableValue[]): Promise<VMResult>;
}

export interface VMModuleHandle {
  readonly specifier: string;
  exports(): readonly string[];
  get(name: string): Promise<VMResult>;
  getFunction(name: string): VMResult<VMFunctionHandle>;
  call(name: string, ...args: VMSerializableValue[]): Promise<VMResult>;
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
      readonly dynamicCode?: boolean;
    };
  };
  readonly state: readonly (readonly [string, VMSerializedValue])[];
}

type VMState = "created" | "started" | "disposed";

interface InstalledCapability {
  readonly name: string;
  readonly capability: VMCapability;
}

type ASTNode = {
  readonly type: string;
  readonly [key: string]: unknown;
};

type VMModuleStatus = "new" | "linking" | "linked" | "evaluating" | "evaluated" | "failed";

interface VMModuleRecord {
  readonly specifier: string;
  readonly source: string;
  readonly program: VMProgram;
  environment: VMEnvironment;
  context: VMExecutionContext;
  readonly dependencies: Map<string, VMModuleRecord>;
  status: VMModuleStatus;
  parsed?: ParsedModuleRecord;
  exports?: Map<string, unknown>;
  namespace?: VMObject;
  failure?: VMError;
}

interface ParsedModuleRecord {
  readonly imports: readonly ModuleImportEntry[];
  readonly localExports: readonly ModuleLocalExportEntry[];
  readonly reExports: readonly ModuleReExportEntry[];
  readonly exportAlls: readonly ModuleExportAllEntry[];
  readonly evaluationProgram: VMProgram;
  readonly dependencySpecifiers: readonly string[];
}

interface ModuleImportEntry {
  readonly specifier: string;
  readonly importName?: string;
  readonly localName: string;
  readonly namespace: boolean;
}

interface ModuleLocalExportEntry {
  readonly exportName: string;
  readonly localName: string;
}

interface ModuleReExportEntry {
  readonly specifier: string;
  readonly importName: string;
  readonly exportName: string;
}

interface ModuleExportAllEntry {
  readonly specifier: string;
  readonly exportName?: string;
}

const ENTRY_MODULE_SPECIFIER = "<entry>";

const SNAPSHOT_EXCLUDED_GLOBALS = new Set<string>([
  "undefined",
  "globalThis",
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
  "Symbol",
  "BigInt",
  "RegExp",
  "Map",
  "Set",
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "isNaN",
  "isFinite",
  "Reflect",
  "Proxy",
  "eval",
  "Function",
  "AsyncFunction",
  "fetch",
  "XMLHttpRequest",
]);

class VMFunctionHandleImpl implements VMFunctionHandle {
  readonly name: string;

  readonly #callable: unknown;
  readonly #getContext: () => VMExecutionContext;
  readonly #thisValue?: unknown;

  constructor(
    name: string,
    callable: unknown,
    getContext: () => VMExecutionContext,
    thisValue?: unknown,
  ) {
    this.name = name;
    this.#callable = callable;
    this.#getContext = getContext;
    this.#thisValue = thisValue;
  }

  async call(...args: VMSerializableValue[]): Promise<VMResult> {
    try {
      const context = this.#getContext();
      return success(
        await invokeGuestCallableForHost(
          this.#callable,
          args,
          context,
          this.#thisValue,
        ),
      );
    } catch (error) {
      return failure(toVMError(error));
    }
  }
}

class VMModuleHandleImpl implements VMModuleHandle {
  readonly specifier: string;

  readonly #exportNames: readonly string[];
  readonly #getContext: () => VMExecutionContext;
  readonly #getExportValue: (name: string) => unknown;
  readonly #createFunctionHandle: (name: string, value: unknown) => VMFunctionHandle;

  constructor(
    specifier: string,
    exportNames: readonly string[],
    getContext: () => VMExecutionContext,
    getExportValue: (name: string) => unknown,
    createFunctionHandle: (name: string, value: unknown) => VMFunctionHandle,
  ) {
    this.specifier = specifier;
    this.#exportNames = Object.freeze([...exportNames]);
    this.#getContext = getContext;
    this.#getExportValue = getExportValue;
    this.#createFunctionHandle = createFunctionHandle;
  }

  exports(): readonly string[] {
    return this.#exportNames;
  }

  async get(name: string): Promise<VMResult> {
    try {
      const context = this.#getContext();
      return success(
        await exportGuestValueForHost(this.#getExportValue(name), context),
      );
    } catch (error) {
      return failure(toVMError(error));
    }
  }

  getFunction(name: string): VMResult<VMFunctionHandle> {
    try {
      this.#getContext();
      const value = this.#getExportValue(name);
      if (!isGuestCallableValue(value)) {
        return failure(
          new VMError(
            VMErrorCode.VMRuntimeError,
            `Module export "${name}" is not callable.`,
            { path: name, reason: "not callable" },
          ),
        );
      }

      return success(this.#createFunctionHandle(name, value));
    } catch (error) {
      return failure(toVMError(error));
    }
  }

  async call(name: string, ...args: VMSerializableValue[]): Promise<VMResult> {
    const handle = this.getFunction(name);
    if (!handle.ok) {
      return handle;
    }

    return handle.value.call(...args);
  }
}

export class VM {
  readonly options: VMOptions;
  readonly dangerously: VMDangerousAPI;
  readonly import: (specifier: string, options?: VMImportOptions) => Promise<VMResult<VMModuleHandle>>;

  #state: VMState = "created";
  #context?: VMExecutionContext;
  #installedCapabilities: InstalledCapability[] = [];
  #networkingRules: readonly NetworkRuleDefinition[];
  #moduleLoader: VMNormalizedModuleLoader;
  #executionRules: VMExecutionRules;
  #numbers: VMNumbersConfig;
  #dynamicCode: boolean;
  #initialGlobals: VMGlobals;
  #restoredState?: readonly (readonly [string, VMSerializedValue])[];
  #generation = 0;
  #moduleGraph = new Map<string, VMModuleRecord>();

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
    this.#moduleLoader = normalizeModuleLoader(options.capabilities?.moduleLoader);
    this.#dynamicCode = options.capabilities?.dynamicCode === true;
    this.#initialGlobals = options.globals ?? {};
    this.import = (specifier, importOptions = {}) =>
      this.#importModule(specifier, importOptions);
    this.dangerously = Object.freeze({
      evaluateUrl: (url: string | URL, evaluateOptions = {}) =>
        this.#evaluateUrl(url, evaluateOptions),
      eval: (url: string | URL, evaluateOptions = {}) =>
        this.#evaluateUrl(url, evaluateOptions),
    });
  }

  static fromSnapshot(snapshot: VMSnapshot): VM {
    assertValidSnapshot(snapshot);

    const vm = new VM({
      capabilities: {
        executionRules: snapshot.options.capabilities.executionRules,
        numbers: snapshot.options.capabilities.numbers,
        networkingRules: snapshot.options.capabilities.networkingRules,
        dynamicCode: snapshot.options.capabilities.dynamicCode,
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
    this.#moduleGraph = new Map();
    this.#generation += 1;
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

  async snapshot(): Promise<VMSnapshot> {
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
          await serializeGuestValueForSnapshot(context.globalEnvironment.get(name), context),
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
          dynamicCode: this.#dynamicCode,
        }),
      }),
      state: Object.freeze(state),
    });
  }

  getGlobalFunction(name: string): VMResult<VMFunctionHandle> {
    try {
      this.#assertUsable();

      if (typeof name !== "string" || name.length === 0) {
        return failure(
          new VMError(
            VMErrorCode.VMRuntimeError,
            "Global function name must be a non-empty string.",
            { path: "name", reason: "invalid global function name" },
          ),
        );
      }

      const context = this.#getContext();
      const value = context.globalEnvironment.get(name);
      if (!isGuestCallableValue(value)) {
        return failure(
          new VMError(
            VMErrorCode.VMRuntimeError,
            `Global "${name}" is not callable.`,
            { path: name, reason: "not callable" },
          ),
        );
      }

      return success(this.#createFunctionHandle(name, value, this.#generation));
    } catch (error) {
      return failure(toVMError(error));
    }
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
      const maxSteps = normalizeMaxSteps(
        options.maxSteps ?? this.#executionRules.maxSteps,
      );
      const evaluationContext = this.#createEvaluationContext(timeLimit, maxSteps);
      const maxSteps = normalizeMaxSteps(
        options.maxSteps ?? this.#executionRules.maxSteps,
      );
      const evaluationContext = this.#createEvaluationContext(timeLimit, maxSteps);
      const program = parseProgram(source, { sourceType: options.sourceType });

      if (program.sourceType === "module") {
        const value = await this.#evaluateModuleEntry(program, source, evaluationContext);
        return success(value);
      }

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
    this.#moduleGraph = new Map();
    const globals = this.#createInitialContextGlobals(includeRestoredState);
    this.#context = createEvaluatorContext({ globals, dateNow: this.#numbers.dateNow });
    this.#generation += 1;
  }

  #createInitialContextGlobals(includeRestoredState: boolean): Readonly<Record<string, unknown>> {
    const globals = Object.create(null) as Record<string, unknown>;
    installBaseGlobals(globals, this.#numbers, this.#networkingRules, this.#dynamicCode);

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

  async #evaluateModuleEntry(
    program: VMProgram,
    source: string,
    rootContext: VMExecutionContext,
  ): Promise<VMSerializableValue> {
    const graph = new Map<string, VMModuleRecord>();
    const entry = this.#createModuleRecord(ENTRY_MODULE_SPECIFIER, source, program, rootContext);
    graph.set(entry.specifier, entry);

    await this.#evaluateModuleRecord(entry, graph, []);

    return reconstructBoundaryValue(
      await serializeGuestValueForSnapshot(
        this.#getModuleNamespace(entry),
        entry.context,
      ),
    );
  }

  async #importModule(
    specifier: string,
    options: VMImportOptions,
  ): Promise<VMResult<VMModuleHandle>> {
    try {
      this.#assertUsable();

      if (typeof specifier !== "string" || specifier.length === 0) {
        return failure(
          new VMError(
            VMErrorCode.VMRuntimeError,
            "Module specifier must be a non-empty string.",
            { path: "specifier", reason: "invalid module specifier" },
          ),
        );
      }

      const timeLimit = normalizeTimeLimit(
        options.timeLimit ?? this.#executionRules.timeLimit,
      );
      const maxSteps = normalizeMaxSteps(
        options.maxSteps ?? this.#executionRules.maxSteps,
      );
      const rootContext = this.#createEvaluationContext(timeLimit, maxSteps);
      const maxSteps = normalizeMaxSteps(
        options.maxSteps ?? this.#executionRules.maxSteps,
      );
      const rootContext = this.#createEvaluationContext(timeLimit, maxSteps);
      const record = await this.#loadRootModule(specifier, rootContext);
      if (record.status !== "evaluated") {
        this.#refreshModuleRecordContext(record, rootContext, new Set());
      }
      await this.#evaluateModuleRecord(record, this.#moduleGraph, []);

      return success(this.#createModuleHandle(record, this.#generation));
    } catch (error) {
      return failure(toVMError(error));
    }
  }

  async #evaluateUrl(
    url: string | URL,
    options: VMDangerousEvaluateUrlOptions,
  ): Promise<VMResult> {
    try {
      this.#assertUsable();

      const href = normalizeEvaluateUrl(url);
      const maxBytes = normalizeMaxBytes(options.maxBytes);
      const timeLimit = normalizeTimeLimit(
        options.timeLimit ?? this.#executionRules.timeLimit,
      );
      const maxSteps = normalizeMaxSteps(
        options.maxSteps ?? this.#executionRules.maxSteps,
      );
      const response = await performHostNetworkRequest(
        [href, { method: "GET" }],
        this.#networkingRules,
      );

      if (!response.ok) {
        return failure(
          new VMError(
            VMErrorCode.VMRuntimeError,
            `URL evaluation failed with HTTP status ${response.status}.`,
            { path: href, reason: "http status" },
          ),
        );
      }

      if (maxBytes !== undefined && utf8ByteLength(response.bodyText) > maxBytes) {
        return failure(
          new VMError(
            VMErrorCode.VMSecurityError,
            "URL evaluation response exceeds maxBytes.",
            { path: href, reason: "max bytes exceeded" },
          ),
        );
      }

      return this.evaluate(response.bodyText, {
        sourceType: options.sourceType,
        timeLimit: options.timeLimit,
        maxSteps: options.maxSteps,
      });
    } catch (error) {
      return failure(toVMError(error));
    }
  }

  async #loadRootModule(
    specifier: string,
    rootContext: VMExecutionContext,
  ): Promise<VMModuleRecord> {
    const resolution = await this.#moduleLoader.resolve({ specifier });
    const existing = this.#moduleGraph.get(resolution.specifier);
    if (existing !== undefined) {
      return existing;
    }

    const source = await this.#moduleLoader.load({
      attributes: resolution.attributes,
      specifier: resolution.specifier,
    });
    return this.#createLoadedModuleRecord(
      source,
      resolution,
      rootContext,
      this.#moduleGraph,
    );
  }

  #createModuleRecord(
    specifier: string,
    source: string,
    program: VMProgram,
    rootContext: VMExecutionContext,
  ): VMModuleRecord {
    const environment = createLexicalEnvironment(rootContext.globalEnvironment);
    const context = createExecutionContext({
      globalEnvironment: rootContext.globalEnvironment,
      globalObject: rootContext.globalObject,
      lexicalEnvironment: environment,
      thisValue: undefined,
      variableEnvironment: environment,
      budget: rootContext.budget,
    });

    return {
      context,
      dependencies: new Map(),
      environment,
      program,
      source,
      specifier,
      status: "new",
    };
  }

  #refreshModuleRecordContext(
    record: VMModuleRecord,
    rootContext: VMExecutionContext,
    seen: Set<VMModuleRecord>,
  ): void {
    if (seen.has(record)) {
      return;
    }

    seen.add(record);
    const environment = createLexicalEnvironment(rootContext.globalEnvironment);
    record.context = createExecutionContext({
      globalEnvironment: rootContext.globalEnvironment,
      globalObject: rootContext.globalObject,
      lexicalEnvironment: environment,
      thisValue: undefined,
      variableEnvironment: environment,
      budget: rootContext.budget,
    });
    record.environment = environment;

    for (const dependency of record.dependencies.values()) {
      this.#refreshModuleRecordContext(dependency, rootContext, seen);
    }
  }

  async #evaluateModuleRecord(
    record: VMModuleRecord,
    graph: Map<string, VMModuleRecord>,
    stack: readonly string[],
  ): Promise<void> {
    if (record.status === "evaluated") {
      return;
    }

    if (record.status === "evaluating" || record.status === "linking") {
      throw moduleRuntimeError("Cyclic ES module graphs are not supported yet.", {
        path: [...stack, record.specifier].join(" -> "),
        reason: "module cycle unsupported",
      });
    }

    if (record.status === "new") {
      record.status = "linking";
      record.parsed = parseModuleRecord(record.program);

      for (const specifier of record.parsed.dependencySpecifiers) {
        await this.#loadModuleDependency(record, specifier, graph);
      }

      record.status = "linked";
    }

    const parsed = record.parsed;
    if (parsed === undefined) {
      throw moduleRuntimeError("Module record was not linked.", {
        path: record.specifier,
        reason: "module link failed",
      });
    }

    record.status = "evaluating";

    try {
      const nextStack = [...stack, record.specifier];
      for (const specifier of parsed.dependencySpecifiers) {
        await this.#evaluateModuleRecord(
          getRequiredDependency(record, specifier, graph),
          graph,
          nextStack,
        );
      }

      this.#installModuleImports(record, parsed, graph);
      await executeProgramForSideEffects(parsed.evaluationProgram, {
        context: record.context,
      });
      record.exports = this.#collectModuleExports(record, parsed, graph);
      record.namespace = createModuleNamespaceObject(record.exports);
      record.status = "evaluated";
    } catch (error) {
      if (
        error instanceof VMError &&
        (error.code === VMErrorCode.VMStepsExceededError ||
          error.code === VMErrorCode.VMTimeoutError)
      ) {
        if (record.status !== "evaluated") {
          record.status = "linked";
          this.#refreshModuleRecordContext(record, record.context, new Set());
        }
      } else if (record.status !== "evaluated") {
        record.status = "failed";
        if (error instanceof VMError) {
          record.failure = error;
        }
      }
      throw error;
    }
  }

  async #loadModuleDependency(
    referrer: VMModuleRecord,
    specifier: string,
    graph: Map<string, VMModuleRecord>,
  ): Promise<VMModuleRecord> {
    const resolution = await this.#moduleLoader.resolve({
      referrer: referrer.specifier,
      specifier,
    });
    const existing = graph.get(resolution.specifier);
    if (existing !== undefined) {
      referrer.dependencies.set(specifier, existing);
      return existing;
    }

    const source = await this.#moduleLoader.load({
      attributes: resolution.attributes,
      referrer: referrer.specifier,
      specifier: resolution.specifier,
    });
    const record = this.#createLoadedModuleRecord(source, resolution, referrer.context, graph);
    referrer.dependencies.set(specifier, record);
    return record;
  }

  #createLoadedModuleRecord(
    source: VMModuleSource,
    resolution: VMModuleResolution,
    rootContext: VMExecutionContext,
    graph: Map<string, VMModuleRecord>,
  ): VMModuleRecord {
    if (source.specifier !== resolution.specifier) {
      throw moduleRuntimeError("Module loader returned a source for a different specifier.", {
        path: resolution.specifier,
        reason: "module specifier mismatch",
      });
    }

    const program = parseProgram(source.source, {
      sourceFile: source.specifier,
      sourceType: "module",
    });
    const record = this.#createModuleRecord(
      source.specifier,
      source.source,
      program,
      rootContext,
    );
    graph.set(record.specifier, record);
    return record;
  }

  #installModuleImports(
    record: VMModuleRecord,
    parsed: ParsedModuleRecord,
    graph: ReadonlyMap<string, VMModuleRecord>,
  ): void {
    for (const entry of parsed.imports) {
      const dependency = getRequiredDependency(record, entry.specifier, graph);
      const value = entry.namespace
        ? this.#getModuleNamespace(dependency)
        : getRequiredModuleExport(dependency, entry.importName ?? "default", record.specifier);

      record.environment.define(entry.localName, {
        deletable: false,
        initialized: true,
        kind: "const",
        mutable: false,
        value,
      });
    }
  }

  #collectModuleExports(
    record: VMModuleRecord,
    parsed: ParsedModuleRecord,
    graph: ReadonlyMap<string, VMModuleRecord>,
  ): Map<string, unknown> {
    const exports = new Map<string, unknown>();

    for (const entry of parsed.exportAlls) {
      const dependency = getRequiredDependency(record, entry.specifier, graph);

      if (entry.exportName !== undefined) {
        setModuleExport(
          exports,
          entry.exportName,
          this.#getModuleNamespace(dependency),
          record.specifier,
        );
        continue;
      }

      for (const [exportName, value] of getModuleExports(dependency)) {
        if (exportName !== "default" && !exports.has(exportName)) {
          exports.set(exportName, value);
        }
      }
    }

    for (const entry of parsed.reExports) {
      const dependency = getRequiredDependency(record, entry.specifier, graph);
      setModuleExport(
        exports,
        entry.exportName,
        getRequiredModuleExport(dependency, entry.importName, record.specifier),
        record.specifier,
      );
    }

    for (const entry of parsed.localExports) {
      setModuleExport(
        exports,
        entry.exportName,
        record.environment.get(entry.localName),
        record.specifier,
      );
    }

    return exports;
  }

  #getModuleNamespace(record: VMModuleRecord): VMObject {
    if (record.namespace !== undefined) {
      return record.namespace;
    }

    if (record.exports === undefined) {
      throw moduleRuntimeError("Module namespace requested before evaluation completed.", {
        path: record.specifier,
        reason: "module namespace unavailable",
      });
    }

    record.namespace = createModuleNamespaceObject(record.exports);
    return record.namespace;
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

  #createEvaluationContext(
    timeLimit: number | undefined,
    maxSteps: number | undefined,
  ): VMExecutionContext {
    const baseContext = this.#getContext();
    return createExecutionContext({
      globalEnvironment: baseContext.globalEnvironment,
      globalObject: baseContext.globalObject,
      lexicalEnvironment: baseContext.globalEnvironment,
      thisValue: baseContext.globalObject,
      variableEnvironment: baseContext.globalEnvironment,
      budget: { timeLimitMs: timeLimit, maxSteps },
      budget: { timeLimitMs: timeLimit, maxSteps },
    });
  }

  #createHandleContext(generation: number): VMExecutionContext {
    this.#assertHandleUsable(generation);
    return this.#createEvaluationContext(
      normalizeTimeLimit(this.#executionRules.timeLimit),
      normalizeMaxSteps(this.#executionRules.maxSteps),
      normalizeMaxSteps(this.#executionRules.maxSteps),
    );
  }

  #assertHandleUsable(generation: number): void {
    this.#assertUsable();

    if (generation !== this.#generation) {
      throw new VMError(
        VMErrorCode.VMRuntimeError,
        "VM handle is no longer valid because the VM was reset or disposed.",
        { reason: "stale handle" },
      );
    }
  }

  #createFunctionHandle(
    name: string,
    callable: unknown,
    generation: number,
    thisValue?: unknown,
  ): VMFunctionHandle {
    return Object.freeze(
      new VMFunctionHandleImpl(
        name,
        callable,
        () => this.#createHandleContext(generation),
        thisValue,
      ),
    );
  }

  #createModuleHandle(
    record: VMModuleRecord,
    generation: number,
  ): VMModuleHandle {
    const exports = getModuleExports(record);
    const exportNames = [...exports.keys()].sort();

    return Object.freeze(
      new VMModuleHandleImpl(
        record.specifier,
        exportNames,
        () => this.#createHandleContext(generation),
        (name) => getRequiredModuleExport(record, name, "<host>"),
        (name, value) =>
          this.#createFunctionHandle(
            `${record.specifier}.${name}`,
            value,
            generation,
          ),
      ),
    );
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
  dynamicCode: boolean,
): void {
  target.undefined = undefined;
  target.NaN = NaN;
  target.Infinity = Infinity;
  target.Math = createSafeMath(numbers.randomSeed);
  target.JSON = createSafeJSON();
  if (dynamicCode) {
    Object.assign(target, createDynamicCodeGlobals());
  }
  Object.assign(target, createNetworkGlobals(networkingRules));
}

function createSafeMath(randomSeed: string | number | undefined): object {
  const rng =
    randomSeed === undefined ? () => Math.random() : createSeededRandom(randomSeed);
  const safeMath = Object.create(null) as Record<string, unknown>;

  for (const key of Object.getOwnPropertyNames(Math)) {
    const value = Math[key as keyof typeof Math];
    if (key === "random") {
      Object.defineProperty(safeMath, key, {
        configurable: true,
        enumerable: false,
        value: createHostCallable(key, () => rng(), { id: `Math.${key}`, arity: 0 }),
        writable: true,
      });
    } else if (typeof value === "function") {
      Object.defineProperty(safeMath, key, {
        configurable: true,
        enumerable: false,
        value: createHostCallable(key, (...args) =>
          (value as (...nextArgs: number[]) => number)(
            ...args.map((arg) => Number(arg)),
          ), { id: `Math.${key}`, arity: value.length }),
        writable: true,
      });
    } else {
      Object.defineProperty(safeMath, key, {
        configurable: true,
        enumerable: false,
        value,
        writable: false,
      });
    }
  }

  Object.defineProperty(safeMath, "constructor", {
    configurable: true,
    enumerable: false,
    value: undefined,
    writable: true,
  });

  return safeMath;
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

function normalizeEvaluateUrl(url: string | URL): string {
  const href = url instanceof URL ? url.href : url;
  if (typeof href !== "string" || href.length === 0) {
    throw new VMError(
      VMErrorCode.VMSecurityError,
      "URL evaluation requires a non-empty URL string.",
      { path: "url", reason: "invalid url" },
    );
  }

  return new URL(href).href;
}

function normalizeMaxBytes(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new VMError(
      VMErrorCode.VMSecurityError,
      "URL evaluation maxBytes must be a non-negative safe integer.",
      { path: "maxBytes", reason: "invalid max bytes" },
    );
  }

  return value;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function success<T>(value: T): VMSuccessResult<T> {
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

function normalizeMaxSteps(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new VMError(
      VMErrorCode.VMRuntimeError,
      "executionRules.maxSteps must be a non-negative safe integer.",
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
          moduleLoader: options.capabilities.moduleLoader,
          dynamicCode: options.capabilities.dynamicCode,
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

function parseModuleRecord(program: VMProgram): ParsedModuleRecord {
  const body = getProgramBody(program);
  const imports: ModuleImportEntry[] = [];
  const localExports: ModuleLocalExportEntry[] = [];
  const reExports: ModuleReExportEntry[] = [];
  const exportAlls: ModuleExportAllEntry[] = [];
  const evaluationBody: ASTNode[] = [];
  const dependencies: string[] = [];
  const explicitExportNames = new Set<string>();
  const usedTopLevelNames = collectTopLevelModuleNames(body);

  const addDependency = (specifier: string) => {
    if (!dependencies.includes(specifier)) {
      dependencies.push(specifier);
    }
  };
  const addLocalExport = (exportName: string, localName: string) => {
    assertUniqueExplicitExport(explicitExportNames, exportName);
    localExports.push({ exportName, localName });
  };
  const addReExport = (entry: ModuleReExportEntry) => {
    assertUniqueExplicitExport(explicitExportNames, entry.exportName);
    reExports.push(entry);
  };

  for (const statement of body) {
    switch (statement.type) {
      case "ImportDeclaration": {
        const specifier = getModuleSource(statement);
        addDependency(specifier);
        for (const specifierNode of getNodeArrayProperty(statement, "specifiers")) {
          imports.push(parseImportSpecifier(specifierNode, specifier));
        }
        break;
      }
      case "ExportDefaultDeclaration": {
        const declaration = getNodeProperty(statement, "declaration");
        const defaultExport = transformDefaultExportDeclaration(
          declaration,
          usedTopLevelNames,
        );
        evaluationBody.push(defaultExport.statement);
        addLocalExport("default", defaultExport.localName);
        break;
      }
      case "ExportNamedDeclaration": {
        const source = getOptionalModuleSource(statement);
        const declaration = statement.declaration;

        if (declaration !== null && declaration !== undefined) {
          const declarationNode = asASTNode(declaration);
          evaluationBody.push(declarationNode);
          for (const localName of collectDeclarationBoundNames(declarationNode)) {
            addLocalExport(localName, localName);
          }
          break;
        }

        if (source !== undefined) {
          addDependency(source);
          for (const specifierNode of getNodeArrayProperty(statement, "specifiers")) {
            const localName = getModuleExportName(getNodeProperty(specifierNode, "local"));
            const exportName = getModuleExportName(getNodeProperty(specifierNode, "exported"));
            addReExport({ exportName, importName: localName, specifier: source });
          }
          break;
        }

        for (const specifierNode of getNodeArrayProperty(statement, "specifiers")) {
          addLocalExport(
            getModuleExportName(getNodeProperty(specifierNode, "exported")),
            getModuleExportName(getNodeProperty(specifierNode, "local")),
          );
        }
        break;
      }
      case "ExportAllDeclaration": {
        const source = getModuleSource(statement);
        addDependency(source);
        const exported = statement.exported;
        exportAlls.push({
          exportName:
            exported === null || exported === undefined
              ? undefined
              : getModuleExportName(asASTNode(exported)),
          specifier: source,
        });
        if (exported !== null && exported !== undefined) {
          assertUniqueExplicitExport(
            explicitExportNames,
            getModuleExportName(asASTNode(exported)),
          );
        }
        break;
      }
      default:
        evaluationBody.push(statement);
        break;
    }
  }

  return Object.freeze({
    dependencySpecifiers: Object.freeze(dependencies),
    evaluationProgram: {
      ...(program as unknown as Record<string, unknown>),
      body: evaluationBody,
      sourceType: "script",
    } as unknown as VMProgram,
    exportAlls: Object.freeze(exportAlls),
    imports: Object.freeze(imports),
    localExports: Object.freeze(localExports),
    reExports: Object.freeze(reExports),
  });
}

function parseImportSpecifier(specifierNode: ASTNode, specifier: string): ModuleImportEntry {
  const localName = getIdentifierName(getNodeProperty(specifierNode, "local"));
  assertSafeGlobalName(localName);

  if (specifierNode.type === "ImportNamespaceSpecifier") {
    return { localName, namespace: true, specifier };
  }

  if (specifierNode.type === "ImportDefaultSpecifier") {
    return { importName: "default", localName, namespace: false, specifier };
  }

  if (specifierNode.type === "ImportSpecifier") {
    return {
      importName: getModuleExportName(getNodeProperty(specifierNode, "imported")),
      localName,
      namespace: false,
      specifier,
    };
  }

  throw moduleRuntimeError("Unsupported import specifier.", {
    path: specifierNode.type,
    reason: "unsupported module syntax",
  });
}

function transformDefaultExportDeclaration(
  declaration: ASTNode,
  usedTopLevelNames: Set<string>,
): { readonly localName: string; readonly statement: ASTNode } {
  if (
    (declaration.type === "FunctionDeclaration" ||
      declaration.type === "ClassDeclaration") &&
    declaration.id !== null &&
    declaration.id !== undefined
  ) {
    return {
      localName: getIdentifierName(asASTNode(declaration.id)),
      statement: declaration,
    };
  }

  const localName = allocateModuleTemporaryName(usedTopLevelNames);
  const init =
    declaration.type === "FunctionDeclaration"
      ? ({ ...declaration, type: "FunctionExpression" } as ASTNode)
      : declaration.type === "ClassDeclaration"
        ? ({ ...declaration, type: "ClassExpression" } as ASTNode)
        : declaration;

  return {
    localName,
    statement: {
      declarations: [
        {
          id: { name: localName, type: "Identifier" },
          init,
          type: "VariableDeclarator",
        },
      ],
      kind: "const",
      type: "VariableDeclaration",
    },
  };
}

function collectTopLevelModuleNames(body: readonly ASTNode[]): Set<string> {
  const names = new Set<string>();

  for (const statement of body) {
    if (statement.type === "ImportDeclaration") {
      for (const specifierNode of getNodeArrayProperty(statement, "specifiers")) {
        names.add(getIdentifierName(getNodeProperty(specifierNode, "local")));
      }
      continue;
    }

    if (
      statement.type === "ExportNamedDeclaration" &&
      statement.declaration !== null &&
      statement.declaration !== undefined
    ) {
      for (const name of collectDeclarationBoundNames(asASTNode(statement.declaration))) {
        names.add(name);
      }
      continue;
    }

    if (statement.type === "ExportDefaultDeclaration") {
      const declaration = getNodeProperty(statement, "declaration");
      if (
        (declaration.type === "FunctionDeclaration" ||
          declaration.type === "ClassDeclaration") &&
        declaration.id !== null &&
        declaration.id !== undefined
      ) {
        names.add(getIdentifierName(asASTNode(declaration.id)));
      }
      continue;
    }

    for (const name of collectDeclarationBoundNames(statement)) {
      names.add(name);
    }
  }

  return names;
}

function collectDeclarationBoundNames(declaration: ASTNode): readonly string[] {
  switch (declaration.type) {
    case "VariableDeclaration":
      return getNodeArrayProperty(declaration, "declarations").flatMap((declarator) =>
        collectPatternBoundNames(getNodeProperty(declarator, "id"))
      );
    case "FunctionDeclaration":
    case "ClassDeclaration":
      return declaration.id === null || declaration.id === undefined
        ? []
        : [getIdentifierName(asASTNode(declaration.id))];
    default:
      return [];
  }
}

function collectPatternBoundNames(pattern: ASTNode): readonly string[] {
  switch (pattern.type) {
    case "Identifier":
      return [getIdentifierName(pattern)];
    case "RestElement":
      return collectPatternBoundNames(getNodeProperty(pattern, "argument"));
    case "AssignmentPattern":
      return collectPatternBoundNames(getNodeProperty(pattern, "left"));
    case "ArrayPattern":
      return getUnknownArrayProperty(pattern, "elements").flatMap((element) =>
        element === null ? [] : collectPatternBoundNames(asASTNode(element))
      );
    case "ObjectPattern":
      return getNodeArrayProperty(pattern, "properties").flatMap((property) => {
        if (property.type === "RestElement") {
          return collectPatternBoundNames(getNodeProperty(property, "argument"));
        }
        return collectPatternBoundNames(getNodeProperty(property, "value"));
      });
    default:
      return [];
  }
}

function allocateModuleTemporaryName(usedTopLevelNames: Set<string>): string {
  let index = 0;
  let name = "__jsvm_module_default__";

  while (usedTopLevelNames.has(name)) {
    index += 1;
    name = `__jsvm_module_default_${index}__`;
  }

  usedTopLevelNames.add(name);
  return name;
}

function getProgramBody(program: VMProgram): readonly ASTNode[] {
  const body = (program as unknown as { readonly body?: unknown }).body;

  if (!Array.isArray(body)) {
    throw moduleRuntimeError("Module program must contain a body.", {
      reason: "invalid ast",
    });
  }

  return body.map(asASTNode);
}

function getRequiredDependency(
  record: VMModuleRecord,
  specifier: string,
  _graph: ReadonlyMap<string, VMModuleRecord>,
): VMModuleRecord {
  const dependency = record.dependencies.get(specifier);
  if (dependency === undefined) {
    throw moduleRuntimeError("Module dependency was not loaded.", {
      path: specifier,
      reason: "module dependency missing",
    });
  }
  return dependency;
}

function getModuleExports(record: VMModuleRecord): ReadonlyMap<string, unknown> {
  if (record.exports === undefined) {
    throw moduleRuntimeError("Module exports requested before evaluation completed.", {
      path: record.specifier,
      reason: "module exports unavailable",
    });
  }

  return record.exports;
}

function getRequiredModuleExport(
  record: VMModuleRecord,
  exportName: string,
  referrer: string,
): unknown {
  const exports = getModuleExports(record);

  if (!exports.has(exportName)) {
    throw moduleRuntimeError(`Module "${record.specifier}" does not export "${exportName}".`, {
      path: exportName,
      reason: "missing module export",
      referrer,
    });
  }

  return exports.get(exportName);
}

function setModuleExport(
  exports: Map<string, unknown>,
  exportName: string,
  value: unknown,
  specifier: string,
): void {
  if (exports.has(exportName)) {
    throw moduleRuntimeError(`Duplicate module export "${exportName}".`, {
      path: exportName,
      reason: "duplicate module export",
      referrer: specifier,
    });
  }

  exports.set(exportName, value);
}

function createModuleNamespaceObject(exports: ReadonlyMap<string, unknown>): VMObject {
  const namespace = createOrdinaryObject(null);

  for (const [name, value] of [...exports.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const defined = defineOwnProperty(namespace, name, {
      configurable: false,
      enumerable: true,
      kind: "data",
      value,
      writable: false,
    });

    if (!defined) {
      throw moduleRuntimeError("Unable to define module namespace export.", {
        path: name,
        reason: "property definition failed",
      });
    }
  }

  preventExtensions(namespace);
  return namespace;
}

function assertUniqueExplicitExport(
  seen: Set<string>,
  exportName: string,
): void {
  if (seen.has(exportName)) {
    throw moduleRuntimeError(`Duplicate module export "${exportName}".`, {
      path: exportName,
      reason: "duplicate module export",
    });
  }

  seen.add(exportName);
}

function getModuleSource(statement: ASTNode): string {
  const source = getOptionalModuleSource(statement);

  if (source === undefined) {
    throw moduleRuntimeError("Module statement is missing a source specifier.", {
      path: statement.type,
      reason: "invalid module source",
    });
  }

  return source;
}

function getOptionalModuleSource(statement: ASTNode): string | undefined {
  const source = statement.source;
  if (source === null || source === undefined) {
    return undefined;
  }

  const sourceNode = asASTNode(source);
  const value = sourceNode.value;
  if (typeof value !== "string") {
    throw moduleRuntimeError("Module source specifiers must be string literals.", {
      path: statement.type,
      reason: "invalid module source",
    });
  }

  return value;
}

function getModuleExportName(node: ASTNode): string {
  if (node.type === "Identifier") {
    return getIdentifierName(node);
  }

  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }

  throw moduleRuntimeError("Module export names must be identifiers or string literals.", {
    path: node.type,
    reason: "invalid module export name",
  });
}

function getIdentifierName(node: ASTNode): string {
  if (node.type !== "Identifier" || typeof node.name !== "string") {
    throw moduleRuntimeError("Expected an identifier.", {
      path: node.type,
      reason: "invalid ast",
    });
  }

  return node.name;
}

function getNodeProperty(node: ASTNode, key: string): ASTNode {
  return asASTNode(node[key]);
}

function getNodeArrayProperty(node: ASTNode, key: string): ASTNode[] {
  return getUnknownArrayProperty(node, key).map(asASTNode);
}

function getUnknownArrayProperty(node: ASTNode, key: string): unknown[] {
  const value = node[key];
  if (!Array.isArray(value)) {
    throw moduleRuntimeError("Expected an AST node array.", {
      path: `${node.type}.${key}`,
      reason: "invalid ast",
    });
  }

  return value;
}

function asASTNode(value: unknown): ASTNode {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { readonly type?: unknown }).type !== "string"
  ) {
    throw moduleRuntimeError("Expected an AST node.", {
      reason: "invalid ast",
    });
  }

  return value as ASTNode;
}

function moduleRuntimeError(
  message: string,
  details: Record<string, string | undefined> = {},
): VMError {
  return new VMError(VMErrorCode.VMRuntimeError, message, details);
}

type StaticModuleStatement = {
  readonly type: string;
  readonly source?: {
    readonly value?: unknown;
  } | null;
};

function collectStaticModuleSpecifiers(program: VMProgram): readonly string[] {
  const body = (program as unknown as { readonly body?: readonly StaticModuleStatement[] }).body;

  if (!Array.isArray(body)) {
    return [];
  }

  const specifiers: string[] = [];

  for (const statement of body) {
    if (
      (statement.type === "ImportDeclaration" ||
        statement.type === "ExportNamedDeclaration" ||
        statement.type === "ExportAllDeclaration") &&
      typeof statement.source?.value === "string"
    ) {
      specifiers.push(statement.source.value);
    }
  }

  return specifiers;
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
