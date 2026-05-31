import { VMError, VMErrorCode, serializeAndReconstructBoundaryValue } from "../boundary";

export type VMBindingKind = "var" | "let" | "const";

export interface VMBinding {
  readonly kind: VMBindingKind;
  readonly mutable: boolean;
  readonly deletable: boolean;
  initialized: boolean;
  value: unknown;
}

export interface DefineBindingOptions {
  readonly kind?: VMBindingKind;
  readonly value?: unknown;
  readonly mutable?: boolean;
  readonly deletable?: boolean;
  readonly initialized?: boolean;
}

export interface VMEnvironmentOptions {
  readonly kind?: "global" | "lexical";
  readonly parent?: VMEnvironment | null;
}

export interface ResolvedBinding {
  readonly environment: VMEnvironment;
  readonly binding: VMBinding;
}

const hasOwn = Object.prototype.hasOwnProperty;

export class VMEnvironment {
  readonly kind: "global" | "lexical";
  readonly parent: VMEnvironment | null;
  readonly #bindings: Record<string, VMBinding>;

  constructor(options: VMEnvironmentOptions = {}) {
    this.kind = options.kind ?? "lexical";
    this.parent = options.parent ?? null;
    this.#bindings = createBindingStorage();
  }

  define(name: string, options: DefineBindingOptions = {}): void {
    assertBindingName(name);

    if (this.hasOwn(name)) {
      throw runtimeError(`Binding "${name}" is already defined.`, {
        reason: "duplicate binding",
        path: name,
      });
    }

    this.#bindings[name] = createBinding(options);
  }

  initialize(name: string, value: unknown): void {
    const resolved = this.resolve(name);

    if (resolved === undefined) {
      throw runtimeError(`Cannot initialize undeclared binding "${name}".`, {
        reason: "missing binding",
        path: name,
      });
    }

    resolved.binding.value = value;
    resolved.binding.initialized = true;
  }

  get(name: string): unknown {
    const resolved = this.resolveOrThrow(name);
    assertInitialized(name, resolved.binding);
    return resolved.binding.value;
  }

  set(name: string, value: unknown): void {
    const resolved = this.resolveOrThrow(name);
    assertInitialized(name, resolved.binding);

    if (!resolved.binding.mutable) {
      throw runtimeError(`Cannot assign to immutable binding "${name}".`, {
        reason: "immutable binding",
        path: name,
      });
    }

    resolved.binding.value = value;
  }

  delete(name: string): boolean {
    assertBindingName(name);
    const resolved = this.resolve(name);

    if (resolved === undefined) {
      return true;
    }

    if (!resolved.binding.deletable) {
      return false;
    }

    delete resolved.environment.#bindings[name];
    return true;
  }

  has(name: string): boolean {
    assertBindingName(name);
    return this.resolve(name) !== undefined;
  }

  hasOwn(name: string): boolean {
    assertBindingName(name);
    return hasOwn.call(this.#bindings, name);
  }

  resolve(name: string): ResolvedBinding | undefined {
    assertBindingName(name);

    if (hasOwn.call(this.#bindings, name)) {
      return { environment: this, binding: this.#bindings[name] };
    }

    return this.parent?.resolve(name);
  }

  getOwnBindingNames(): readonly string[] {
    return Object.freeze(Object.keys(this.#bindings));
  }

  snapshotInitializedBindings(): Record<string, unknown> {
    const snapshot = Object.create(null) as Record<string, unknown>;

    for (const [name, binding] of Object.entries(this.#bindings)) {
      if (binding.initialized) {
        snapshot[name] = serializeAndReconstructBoundaryValue(binding.value, {
          allowCapabilities: false,
        });
      }
    }

    return snapshot;
  }

  getOwnBindingForDiagnostics(name: string): VMBinding | undefined {
    assertBindingName(name);
    return this.#bindings[name];
  }

  resolveOrThrow(name: string): ResolvedBinding {
    const resolved = this.resolve(name);

    if (resolved === undefined) {
      throw runtimeError(`Binding "${name}" is not defined.`, {
        reason: "missing binding",
        path: name,
      });
    }

    return resolved;
  }
}

export function createGlobalEnvironment(
  bindings: Readonly<Record<string, unknown>> = {},
): VMEnvironment {
  const environment = new VMEnvironment({ kind: "global" });

  for (const [name, value] of Object.entries(bindings)) {
    environment.define(name, {
      kind: "var",
      value: serializeAndReconstructBoundaryValue(value, { allowCapabilities: false }),
      mutable: true,
      deletable: true,
      initialized: true,
    });
  }

  return environment;
}

export function createLexicalEnvironment(parent: VMEnvironment): VMEnvironment {
  return new VMEnvironment({ kind: "lexical", parent });
}

function createBindingStorage(): Record<string, VMBinding> {
  return Object.create(null) as Record<string, VMBinding>;
}

function createBinding(options: DefineBindingOptions): VMBinding {
  const kind = options.kind ?? "let";
  const hasValue = hasOwn.call(options, "value");
  const initialized = options.initialized ?? (hasValue || kind === "var");

  return {
    kind,
    mutable: options.mutable ?? kind !== "const",
    deletable: options.deletable ?? kind === "var",
    initialized,
    value: initialized ? options.value : undefined,
  };
}

function assertBindingName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw runtimeError("Binding names must be non-empty strings.", {
      reason: "invalid binding name",
      valueType: typeof name,
    });
  }
}

function assertInitialized(name: string, binding: VMBinding): void {
  if (!binding.initialized) {
    throw runtimeError(`Cannot access binding "${name}" before initialization.`, {
      reason: "temporal dead zone",
      path: name,
    });
  }
}

function runtimeError(message: string, details: Record<string, string | undefined> = {}): VMError {
  return new VMError(VMErrorCode.VMRuntimeError, message, details);
}
