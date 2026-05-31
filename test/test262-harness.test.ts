import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  classifyVMResult,
  getTest262HarnessIncludeSource,
  getStaticUnsupportedReason,
  parseTest262Args,
  parseTest262Metadata,
  runTest262,
} from "../scripts/run-test262";
import { VMError, VMErrorCode, type VMResult } from "../src/index";

describe("test262 harness scaffold helpers", () => {
  test("parses CLI args with explicit directory, filters, limit, and timeout", () => {
    expect(
      parseTest262Args(
        [
          "--test262-dir",
          "../test262",
          "--filter=test/language/expressions/addition",
          "--limit",
          "5",
          "--timeout-ms=250",
          "--verbose",
          "test/built-ins/Math/abs",
        ],
        {},
      ),
    ).toEqual({
      help: false,
      test262Dir: "../test262",
      filters: ["test/language/expressions/addition", "test/built-ins/Math/abs"],
      limit: 5,
      timeoutMs: 250,
      verbose: true,
    });
  });

  test("parses common test262 metadata arrays and negative blocks", () => {
    const metadata = parseTest262Metadata(`/*---
description: example
flags: [onlyStrict, generated]
includes:
  - compareArray.js
features: [Symbol]
negative:
  phase: parse
  type: SyntaxError
---*/
1;`);

    expect(metadata).toEqual({
      flags: ["onlyStrict", "generated"],
      includes: ["compareArray.js"],
      features: ["Symbol"],
      negative: { phase: "parse", type: "SyntaxError" },
    });
  });

  test("classifies VM failures as fail or unsupported", () => {
    const assertionFailure: VMResult = {
      ok: false,
      error: new VMError(VMErrorCode.VMRuntimeError, "Test262Error: expected true"),
    };
    const unsupportedFailure: VMResult = {
      ok: false,
      error: new VMError(VMErrorCode.VMRuntimeError, "Only identifier bindings are supported.", {
        reason: "unsupported syntax",
      }),
    };

    expect(classifyVMResult(assertionFailure, { flags: [], includes: [], features: [] })).toEqual({
      status: "fail",
      message: "VM_RUNTIME_ERROR: Test262Error: expected true",
    });
    expect(classifyVMResult(unsupportedFailure, { flags: [], includes: [], features: [] })).toEqual(
      {
        status: "unsupported",
        message: "VM_RUNTIME_ERROR (unsupported syntax): Only identifier bindings are supported.",
      },
    );
    expect(
      classifyVMResult(
        { ok: true, value: 1 },
        {
          flags: [],
          includes: [],
          features: [],
          negative: { phase: "runtime", type: "TypeError" },
        },
      ),
    ).toEqual({ status: "fail", message: "Expected negative test to fail during runtime." });
  });

  test("reports static unsupported harness modes", () => {
    expect(getStaticUnsupportedReason({ flags: ["module"], includes: [], features: [] })).toContain(
      "module",
    );
    expect(getStaticUnsupportedReason({ flags: ["async"], includes: [], features: [] })).toContain(
      "async",
    );
  });

  test("uses lightweight shims for harness includes that need unsupported primordials", () => {
    const propertyHelper = getTest262HarnessIncludeSource("propertyHelper.js", ".");
    const isConstructor = getTest262HarnessIncludeSource("isConstructor.js", ".");

    expect(propertyHelper).toMatchObject({ shimmed: true });
    expect(propertyHelper?.source).toContain("function verifyProperty");
    expect(isConstructor).toMatchObject({ shimmed: true });
    expect(isConstructor?.source).toContain("function isConstructor");
  });

  test("runs fixture tests with dynamic code and Test262Error prelude support", async () => {
    const summary = await runTest262({
      test262Dir: join(import.meta.dir, "fixtures", "test262-harness"),
      filters: ["test"],
      timeoutMs: 100,
      verbose: false,
    });

    expect(summary).toMatchObject({ total: 2, pass: 2, fail: 0, unsupported: 0 });
  });
});
