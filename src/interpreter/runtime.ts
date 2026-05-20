import { VMError, VMErrorCode } from "../boundary";
import {
  VMEnvironment,
  createGlobalEnvironment,
  createLexicalEnvironment,
} from "./environment";
import { createOrdinaryObject, type VMObject } from "./object-model";

export type VMCompletionType = "normal" | "return" | "break" | "continue" | "throw";

export interface VMCompletion<T = unknown> {
  readonly type: VMCompletionType;
  readonly value?: T;
  readonly target?: string;
}

export interface ExecutionBudgetOptions {
  readonly maxSteps?: number;
  readonly timeLimitMs?: number;
  readonly now?: () => number;
}

export interface VMExecutionContextOptions {
  readonly globalEnvironment?: VMEnvironment;
  readonly lexicalEnvironment?: VMEnvironment;
  readonly variableEnvironment?: VMEnvironment;
  readonly globalObject?: VMObject;
  readonly thisValue?: unknown;
  readonly budget?: ExecutionBudget | ExecutionBudgetOptions;
}

export function normalCompletion<T = unknown>(value?: T): VMCompletion<T> {
  return Object.freeze({ type: "normal" as const, value });
}

export function returnCompletion<T = unknown>(value?: T): VMCompletion<T> {
  return Object.freeze({ type: "return" as const, value });
}

export function throwCompletion<T = unknown>(value: T): VMCompletion<T> {
  return Object.freeze({ type: "throw" as const, value });
}

export function breakCompletion(target?: string): VMCompletion<undefined> {
  return Object.freeze({ type: "break" as const, target });
}

export function continueCompletion(target?: string): VMCompletion<undefined> {
  return Object.freeze({ type: "continue" as const, target });
}

export function isAbruptCompletion(completion: VMCompletion): boolean {
  return completion.type !== "normal";
}

export function unwrapNormalCompletion<T>(completion: VMCompletion<T>): T | undefined {
  if (completion.type !== "normal") {
    throw new VMError(VMErrorCode.VMRuntimeError, "Expected a normal completion record.", {
      reason: completion.type,
    });
  }

  return completion.value;
}

export class ExecutionBudget {
  readonly maxSteps?: number;
  readonly timeLimitMs?: number;
  readonly #now: () => number;
  #startedAt: number;
  #stepsUsed = 0;

  constructor(options: ExecutionBudgetOptions = {}) {
    this.maxSteps = normalizeNonNegativeInteger(options.maxSteps, "maxSteps");
    this.timeLimitMs = normalizeNonNegativeNumber(options.timeLimitMs, "timeLimitMs");
    this.#now = options.now ?? (() => Date.now());
    this.#startedAt = this.#now();
  }

  get stepsUsed(): number {
    return this.#stepsUsed;
  }

  get remainingSteps(): number | undefined {
    return this.maxSteps === undefined
      ? undefined
      : Math.max(0, this.maxSteps - this.#stepsUsed);
  }

  get elapsedMs(): number {
    return Math.max(0, this.#now() - this.#startedAt);
  }

  checkpoint(stepCost = 1, reason = "execution checkpoint"): void {
    const normalizedCost = normalizePositiveInteger(stepCost, "stepCost");
    this.#stepsUsed += normalizedCost;

    if (this.maxSteps !== undefined && this.#stepsUsed > this.maxSteps) {
      throw budgetError(
        VMErrorCode.VMStepsExceededError,
        "Execution step budget exhausted.",
        {
          reason,
          path: "maxSteps",
        },
      );
    }

    if (this.timeLimitMs !== undefined && this.elapsedMs > this.timeLimitMs) {
      throw budgetError(
        VMErrorCode.VMTimeoutError,
        "Execution time limit exceeded.",
        {
          reason,
          path: "timeLimitMs",
        },
      );
    }
  }

  reset(): void {
    this.#stepsUsed = 0;
    this.#startedAt = this.#now();
  }
}

export class VMExecutionContext {
  readonly globalEnvironment: VMEnvironment;
  readonly globalObject: VMObject;
  variableEnvironment: VMEnvironment;
  lexicalEnvironment: VMEnvironment;
  thisValue: unknown;
  readonly budget: ExecutionBudget;

  constructor(options: VMExecutionContextOptions = {}) {
    this.globalEnvironment = options.globalEnvironment ?? createGlobalEnvironment();
    this.globalObject = options.globalObject ?? createOrdinaryObject();
    this.lexicalEnvironment = options.lexicalEnvironment ?? this.globalEnvironment;
    this.variableEnvironment = options.variableEnvironment ?? this.globalEnvironment;
    this.thisValue = options.thisValue ?? this.globalObject;
    this.budget =
      options.budget instanceof ExecutionBudget
        ? options.budget
        : new ExecutionBudget(options.budget);
  }

  checkpoint(stepCost = 1, reason?: string): void {
    this.budget.checkpoint(stepCost, reason);
  }

  enterLexicalEnvironment(environment = createLexicalEnvironment(this.lexicalEnvironment)): VMEnvironment {
    this.lexicalEnvironment = environment;
    return environment;
  }

  leaveLexicalEnvironment(expected?: VMEnvironment): VMEnvironment {
    if (expected !== undefined && expected !== this.lexicalEnvironment) {
      throw new VMError(VMErrorCode.VMRuntimeError, "Cannot leave a non-current lexical environment.", {
        reason: "lexical environment mismatch",
      });
    }

    if (this.lexicalEnvironment === this.globalEnvironment) {
      throw new VMError(VMErrorCode.VMRuntimeError, "Cannot leave the global lexical environment.", {
        reason: "global environment",
      });
    }

    this.lexicalEnvironment = this.lexicalEnvironment.parent ?? this.globalEnvironment;
    return this.lexicalEnvironment;
  }
}

export function createExecutionBudget(options: ExecutionBudgetOptions = {}): ExecutionBudget {
  return new ExecutionBudget(options);
}

export function createExecutionContext(
  options: VMExecutionContextOptions = {},
): VMExecutionContext {
  return new VMExecutionContext(options);
}

function normalizeNonNegativeInteger(
  value: number | undefined,
  name: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }

  return value;
}

function normalizePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }

  return value;
}

function normalizeNonNegativeNumber(
  value: number | undefined,
  name: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number.`);
  }

  return value;
}

function budgetError(
  code: VMErrorCode,
  message: string,
  details: Record<string, string>,
): VMError {
  return new VMError(code, message, details);
}
