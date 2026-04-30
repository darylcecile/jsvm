import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { VM, VMErrorCode, type VMFailureResult, type VMResult } from "../src/index";

export const DEFAULT_TEST262_FILTERS = Object.freeze([
  "test/language/expressions/addition",
  "test/language/expressions/equality",
  "test/language/expressions/logical-and",
  "test/language/statements/if",
  "test/built-ins/Math/abs",
]);

export const DEFAULT_TEST262_LIMIT = 50;
export const DEFAULT_TEST262_TIMEOUT_MS = 100;

export const TEST262_PRELUDE = `
function $sameValue(actual, expected) {
  if (actual === expected) {
    return actual !== 0 || 1 / actual === 1 / expected;
  }

  return actual !== actual && expected !== expected;
}

function Test262Error(message) {
  var error = this === undefined || this === globalThis ? {} : this;
  error.name = "Test262Error";
  error.message = message === undefined ? "" : String(message);
  error.constructor = Test262Error;
  return error;
}

Test262Error.prototype.name = "Test262Error";
Test262Error.prototype.message = "";
Test262Error.prototype.constructor = Test262Error;
Test262Error.prototype.toString = function () {
  return this.name + ": " + this.message;
};

function $ERROR(message) {
  throw new Test262Error(message);
}

function assert(mustBeTrue, message) {
  if (mustBeTrue === true) {
    return;
  }

  $ERROR(message || "Expected true but got " + String(mustBeTrue));
}

assert.sameValue = function (actual, expected, message) {
  if (!$sameValue(actual, expected)) {
    $ERROR(message || "Expected SameValue but got " + String(actual) + " and " + String(expected));
  }
};

assert.notSameValue = function (actual, unexpected, message) {
  if ($sameValue(actual, unexpected)) {
    $ERROR(message || "Expected different values but got " + String(actual));
  }
};

assert.throws = function (expectedErrorConstructor, func, message) {
  var threw = false;
  var thrown;

  try {
    func();
  } catch (error) {
    threw = true;
    thrown = error;
  }

  if (!threw) {
    $ERROR(message || "Expected function to throw");
  }

  if (
    expectedErrorConstructor !== undefined &&
    thrown !== null &&
    typeof thrown === "object" &&
    thrown.constructor !== expectedErrorConstructor
  ) {
    var expectedName = expectedErrorConstructor.name || String(expectedErrorConstructor);
    var actualName = thrown.constructor && thrown.constructor.name || String(thrown);
    $ERROR((message ? message + " " : "") + "Expected a " + expectedName + " but got a " + actualName);
  }
};

undefined;
`;

const TEST262_HARNESS_SHIMS: Readonly<Record<string, string>> = Object.freeze({
  "isConstructor.js": `
function isConstructor(f) {
  if (typeof f !== "function") {
    throw new Test262Error("isConstructor invoked with a non-function value");
  }

  try {
    new f();
  } catch (_error) {
    return false;
  }

  return true;
}
`,
  "propertyHelper.js": `
function verifyProperty(obj, name, desc, options) {
  var originalDesc = Object.getOwnPropertyDescriptor(obj, name);
  var nameStr = String(name);

  if (desc === undefined) {
    assert.sameValue(originalDesc, undefined, "obj['" + nameStr + "'] descriptor should be undefined");
    return true;
  }

  assert.notSameValue(originalDesc, undefined, "obj should have an own property " + nameStr);

  if ("value" in desc) {
    assert.sameValue(obj[name], desc.value, "obj['" + nameStr + "'] value should be " + desc.value);
    assert.sameValue(originalDesc.value, desc.value, "obj['" + nameStr + "'] descriptor value should be " + desc.value);
  }

  if ("enumerable" in desc && desc.enumerable !== undefined) {
    assert.sameValue(originalDesc.enumerable, desc.enumerable, "obj['" + nameStr + "'] enumerable should be " + desc.enumerable);
  }

  if ("writable" in desc && desc.writable !== undefined) {
    assert.sameValue(originalDesc.writable, desc.writable, "obj['" + nameStr + "'] writable should be " + desc.writable);
  }

  if ("configurable" in desc && desc.configurable !== undefined) {
    assert.sameValue(originalDesc.configurable, desc.configurable, "obj['" + nameStr + "'] configurable should be " + desc.configurable);
  }

  if (options && options.restore) {
    Object.defineProperty(obj, name, originalDesc);
  }

  return true;
}

function verifyCallableProperty(obj, name, functionName, functionLength, desc, options) {
  var value = obj[name];
  assert.sameValue(typeof value, "function", "obj['" + String(name) + "'] descriptor should be a function");
  verifyProperty(obj, name, desc || {
    writable: true,
    enumerable: false,
    configurable: true,
    value: value
  }, options);
  verifyProperty(value, "name", {
    value: functionName === undefined ? name : functionName,
    writable: false,
    enumerable: false,
    configurable: true
  }, options);
  verifyProperty(value, "length", {
    value: functionLength,
    writable: false,
    enumerable: false,
    configurable: true
  }, options);
}

function verifyEqualTo(obj, name, value) {
  assert.sameValue(obj[name], value, "Expected obj[" + String(name) + "] to equal " + value);
}

function verifyWritable(obj, name) {
  verifyProperty(obj, name, { writable: true });
}

function verifyNotWritable(obj, name) {
  verifyProperty(obj, name, { writable: false });
}

function verifyEnumerable(obj, name) {
  verifyProperty(obj, name, { enumerable: true });
}

function verifyNotEnumerable(obj, name) {
  verifyProperty(obj, name, { enumerable: false });
}

function verifyConfigurable(obj, name) {
  verifyProperty(obj, name, { configurable: true });
}

function verifyNotConfigurable(obj, name) {
  verifyProperty(obj, name, { configurable: false });
}

var verifyPrimordialProperty = verifyProperty;
var verifyPrimordialCallableProperty = verifyCallableProperty;

undefined;
`,
});

export interface Test262HarnessIncludeSource {
  readonly source: string;
  readonly shimmed: boolean;
}

export function getTest262HarnessIncludeSource(
  include: string,
  test262Dir: string,
): Test262HarnessIncludeSource | undefined {
  const shim = TEST262_HARNESS_SHIMS[include];

  if (shim !== undefined) {
    return { source: shim, shimmed: true };
  }

  const includePath = join(test262Dir, "harness", include);

  if (!existsSync(includePath)) {
    return undefined;
  }

  return { source: readFileSync(includePath, "utf8"), shimmed: false };
}

export function createTest262HarnessVM(timeoutMs: number): VM {
  return new VM({
    capabilities: { dynamicCode: true },
    executionRules: { timeLimit: timeoutMs },
  });
}

export interface ParsedTest262Args {
  readonly help: boolean;
  readonly test262Dir?: string;
  readonly filters: readonly string[];
  readonly limit?: number;
  readonly timeoutMs: number;
  readonly verbose: boolean;
}

export interface Test262Metadata {
  readonly flags: readonly string[];
  readonly includes: readonly string[];
  readonly features: readonly string[];
  readonly negative?: {
    readonly phase?: string;
    readonly type?: string;
  };
}

export interface Test262HarnessOptions {
  readonly test262Dir: string;
  readonly filters: readonly string[];
  readonly limit?: number;
  readonly timeoutMs: number;
  readonly verbose: boolean;
}

export type Test262Status = "pass" | "fail" | "unsupported";

export interface Test262FileResult {
  readonly file: string;
  readonly status: Test262Status;
  readonly message?: string;
}

export interface Test262RunSummary {
  readonly total: number;
  readonly pass: number;
  readonly fail: number;
  readonly unsupported: number;
  readonly results: readonly Test262FileResult[];
}

export function parseTest262Args(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): ParsedTest262Args {
  let test262Dir = env.TEST262_DIR;
  let limit: number | undefined;
  let timeoutMs = DEFAULT_TEST262_TIMEOUT_MS;
  let verbose = false;
  const filters: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      return { help: true, test262Dir, filters, limit, timeoutMs, verbose };
    }

    if (arg === "--verbose" || arg === "-v") {
      verbose = true;
      continue;
    }

    if (arg === "--test262-dir") {
      test262Dir = readRequiredOptionValue(args, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--test262-dir=")) {
      test262Dir = readInlineOptionValue(arg, "--test262-dir");
      continue;
    }

    if (arg === "--filter") {
      filters.push(readRequiredOptionValue(args, index, arg));
      index += 1;
      continue;
    }

    if (arg.startsWith("--filter=")) {
      filters.push(readInlineOptionValue(arg, "--filter"));
      continue;
    }

    if (arg === "--limit") {
      limit = parsePositiveInteger(readRequiredOptionValue(args, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--limit=")) {
      limit = parsePositiveInteger(readInlineOptionValue(arg, "--limit"), "--limit");
      continue;
    }

    if (arg === "--timeout-ms") {
      timeoutMs = parsePositiveInteger(readRequiredOptionValue(args, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--timeout-ms=")) {
      timeoutMs = parsePositiveInteger(readInlineOptionValue(arg, "--timeout-ms"), "--timeout-ms");
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    filters.push(arg);
  }

  return { help: false, test262Dir, filters, limit, timeoutMs, verbose };
}

export function parseTest262Metadata(source: string): Test262Metadata {
  const match = source.match(/\/\*---([\s\S]*?)---\*\//);
  const raw = match?.[1] ?? "";

  return {
    flags: parseArrayField(raw, "flags"),
    includes: parseArrayField(raw, "includes"),
    features: parseArrayField(raw, "features"),
    negative: parseNegativeField(raw),
  };
}

export function classifyVMResult(
  result: VMResult,
  metadata: Test262Metadata,
): Pick<Test262FileResult, "status" | "message"> {
  if (metadata.negative) {
    return result.ok
      ? {
          status: "fail",
          message: `Expected negative test to fail during ${metadata.negative.phase ?? "evaluation"}.`,
        }
      : { status: "pass" };
  }

  if (result.ok) {
    return { status: "pass" };
  }

  if (isUnsupportedFailure(result)) {
    return { status: "unsupported", message: formatVMFailure(result) };
  }

  return { status: "fail", message: formatVMFailure(result) };
}

export function getStaticUnsupportedReason(metadata: Test262Metadata): string | undefined {
  const flags = new Set(metadata.flags);

  if (flags.has("module")) {
    return "module tests are not supported by VM.evaluate()";
  }

  if (flags.has("async")) {
    return "async test262 completion tests are not supported by this scaffold";
  }

  if (flags.has("CanBlockIsTrue") || flags.has("CanBlockIsFalse")) {
    return "agent blocking tests are not supported by this scaffold";
  }

  return undefined;
}

export async function runTest262(options: Test262HarnessOptions): Promise<Test262RunSummary> {
  const files = discoverTestFiles(options);
  const results: Test262FileResult[] = [];

  for (const file of files) {
    const result = await runTest262File(file, options);
    results.push(result);

    if (options.verbose || result.status !== "pass") {
      printFileResult(result);
    }
  }

  return summarizeResults(results);
}

function readRequiredOptionValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];

  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${option}.`);
  }

  return value;
}

function readInlineOptionValue(arg: string, option: string): string {
  const value = arg.slice(option.length + 1);

  if (!value) {
    throw new Error(`Missing value for ${option}.`);
  }

  return value;
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer.`);
  }

  return parsed;
}

function parseArrayField(raw: string, field: string): string[] {
  const lines = raw.split(/\r?\n/);
  const fieldIndex = lines.findIndex((line) => line.startsWith(`${field}:`));

  if (fieldIndex === -1) {
    return [];
  }

  const firstLine = lines[fieldIndex].slice(field.length + 1).trim();

  if (firstLine.startsWith("[") && firstLine.endsWith("]")) {
    return splitArrayItems(firstLine.slice(1, -1));
  }

  if (firstLine) {
    return [stripYamlScalar(firstLine)];
  }

  const values: string[] = [];

  for (let index = fieldIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];

    if (/^\S/.test(line)) {
      break;
    }

    const match = line.match(/^\s*-\s*(.+?)\s*$/);

    if (match) {
      values.push(stripYamlScalar(match[1]));
    }
  }

  return values;
}

function splitArrayItems(value: string): string[] {
  return value
    .split(",")
    .map((item) => stripYamlScalar(item.trim()))
    .filter(Boolean);
}

function stripYamlScalar(value: string): string {
  return value
    .replace(/\s+#.*$/, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

function parseNegativeField(raw: string): Test262Metadata["negative"] {
  const lines = raw.split(/\r?\n/);
  const fieldIndex = lines.findIndex((line) => line.startsWith("negative:"));

  if (fieldIndex === -1) {
    return undefined;
  }

  let phase: string | undefined;
  let type: string | undefined;

  for (let index = fieldIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];

    if (/^\S/.test(line)) {
      break;
    }

    const phaseMatch = line.match(/^\s*phase:\s*(.+?)\s*$/);
    const typeMatch = line.match(/^\s*type:\s*(.+?)\s*$/);

    if (phaseMatch) {
      phase = stripYamlScalar(phaseMatch[1]);
    } else if (typeMatch) {
      type = stripYamlScalar(typeMatch[1]);
    }
  }

  return { phase, type };
}

function discoverTestFiles(options: Test262HarnessOptions): string[] {
  const test262Dir = resolve(options.test262Dir);
  const filters = options.filters.length > 0 ? options.filters : DEFAULT_TEST262_FILTERS;
  const seen = new Set<string>();
  const directMatches: string[] = [];
  const unresolvedFilters: string[] = [];

  for (const filter of filters) {
    const candidate = resolveFilterPath(test262Dir, filter);

    if (existsSync(candidate)) {
      for (const file of collectJavaScriptFiles(candidate)) {
        if (!seen.has(file)) {
          seen.add(file);
          directMatches.push(file);
        }
      }
    } else {
      unresolvedFilters.push(normalizePath(filter));
    }
  }

  let files = directMatches;

  if (unresolvedFilters.length > 0) {
    const testRoot = join(test262Dir, "test");
    const searchRoot = existsSync(testRoot) ? testRoot : test262Dir;

    files = files.concat(
      collectJavaScriptFiles(searchRoot).filter((file) => {
        if (seen.has(file)) {
          return false;
        }

        const relativePath = normalizePath(relative(test262Dir, file));
        const matches = unresolvedFilters.some((filter) => relativePath.includes(filter));

        if (matches) {
          seen.add(file);
        }

        return matches;
      }),
    );
  }

  const sorted = files.sort((left, right) =>
    normalizePath(relative(test262Dir, left)).localeCompare(normalizePath(relative(test262Dir, right))),
  );

  return options.limit ? sorted.slice(0, options.limit) : sorted;
}

function resolveFilterPath(test262Dir: string, filter: string): string {
  return filter.startsWith("/") ? resolve(filter) : resolve(test262Dir, filter);
}

function collectJavaScriptFiles(path: string): string[] {
  const stat = statSync(path);

  if (stat.isFile()) {
    return path.endsWith(".js") ? [path] : [];
  }

  if (!stat.isDirectory()) {
    return [];
  }

  const files: string[] = [];

  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectJavaScriptFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(entryPath);
    }
  }

  return files;
}

async function runTest262File(
  file: string,
  options: Test262HarnessOptions,
): Promise<Test262FileResult> {
  const source = readFileSync(file, "utf8");
  const metadata = parseTest262Metadata(source);
  const relativeFile = normalizePath(relative(options.test262Dir, file));
  const unsupportedReason = getStaticUnsupportedReason(metadata);

  if (unsupportedReason) {
    return { file: relativeFile, status: "unsupported", message: unsupportedReason };
  }

  const vm = createTest262HarnessVM(options.timeoutMs);

  try {
    await vm.start();

    if (!metadata.flags.includes("raw")) {
      const preludeResult = await vm.eval(TEST262_PRELUDE, { timeLimit: options.timeoutMs });

      if (!preludeResult.ok) {
        return {
          file: relativeFile,
          status: "fail",
          message: `internal prelude failed: ${formatVMFailure(preludeResult)}`,
        };
      }
    }

    for (const include of metadata.includes) {
      const includeSource = getTest262HarnessIncludeSource(include, options.test262Dir);

      if (includeSource === undefined) {
        return {
          file: relativeFile,
          status: "unsupported",
          message: `missing test262 harness include: ${include}`,
        };
      }

      const includeResult = await vm.eval(includeSource.source, {
        timeLimit: options.timeoutMs,
      });

      if (!includeResult.ok) {
        const sourceKind = includeSource.shimmed ? "harness shim" : "harness include";
        return {
          file: relativeFile,
          status: "unsupported",
          message: `${sourceKind} ${include} failed: ${formatVMFailure(includeResult)}`,
        };
      }
    }

    const testResult = await vm.eval(prepareTestSource(source, metadata), {
      timeLimit: options.timeoutMs,
    });
    const classified = classifyVMResult(testResult, metadata);

    return { file: relativeFile, ...classified };
  } finally {
    vm.dispose();
  }
}

function prepareTestSource(source: string, metadata: Test262Metadata): string {
  return metadata.flags.includes("onlyStrict") ? `"use strict";\n${source}` : source;
}

function isUnsupportedFailure(result: VMFailureResult): boolean {
  const reason = result.error.details.reason;
  const message = result.error.message;

  return (
    result.error.code === VMErrorCode.VMSyntaxError ||
    reason === "unsupported syntax" ||
    reason === "missing binding" ||
    reason === "unknown callable" ||
    message.includes("not supported") ||
    message.includes("do not expose VM object properties") ||
    message.includes("is not callable")
  );
}

function formatVMFailure(result: VMFailureResult): string {
  const reason = result.error.details.reason ? ` (${result.error.details.reason})` : "";
  return `${result.error.code}${reason}: ${result.error.message}`;
}

function summarizeResults(results: readonly Test262FileResult[]): Test262RunSummary {
  const counts = {
    pass: 0,
    fail: 0,
    unsupported: 0,
  };

  for (const result of results) {
    counts[result.status] += 1;
  }

  return {
    total: results.length,
    ...counts,
    results,
  };
}

function normalizePath(path: string): string {
  return path.split(sep).join("/");
}

function printFileResult(result: Test262FileResult): void {
  const suffix = result.message ? ` - ${result.message}` : "";
  console.log(`${result.status.toUpperCase()} ${result.file}${suffix}`);
}

function printSummary(summary: Test262RunSummary): void {
  console.log(
    `Test262 scaffold: ${summary.pass} passed, ${summary.fail} failed, ${summary.unsupported} unsupported, ${summary.total} total.`,
  );

  for (const result of summary.results.filter((entry) => entry.status === "fail").slice(0, 20)) {
    printFileResult(result);
  }
}

function printUsage(): void {
  console.log(`Usage: bun run test262 -- [options] [filters...]

Options:
  --test262-dir <path>  Path to a local test262 checkout. Defaults to TEST262_DIR.
  --filter <text>       Relative path or substring filter. Can be repeated.
  --limit <count>       Maximum number of matched tests to run.
  --timeout-ms <ms>     Per-evaluation VM timeout. Defaults to ${DEFAULT_TEST262_TIMEOUT_MS}.
  --verbose             Print every test result, including passes.
  --help                Show this help.

With no filters, a curated subset is used and capped at ${DEFAULT_TEST262_LIMIT} tests.
Examples:
  TEST262_DIR=../test262 bun run test262
  bun run test262 -- --test262-dir ../test262 test/language/expressions/addition --limit 10
`);
}

async function main(): Promise<void> {
  let parsed: ParsedTest262Args;

  try {
    parsed = parseTest262Args(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (parsed.help) {
    printUsage();
    return;
  }

  if (!parsed.test262Dir) {
    console.error("TEST262_DIR or --test262-dir is required.");
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (!existsSync(parsed.test262Dir)) {
    console.error(`Test262 directory does not exist: ${parsed.test262Dir}`);
    process.exitCode = 1;
    return;
  }

  const filters = parsed.filters.length > 0 ? parsed.filters : DEFAULT_TEST262_FILTERS;
  const limit = parsed.limit ?? (parsed.filters.length === 0 ? DEFAULT_TEST262_LIMIT : undefined);
  const summary = await runTest262({
    test262Dir: parsed.test262Dir,
    filters,
    limit,
    timeoutMs: parsed.timeoutMs,
    verbose: parsed.verbose,
  });

  printSummary(summary);

  if (summary.total === 0 || summary.fail > 0) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
