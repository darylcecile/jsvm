import { describe, expect, test } from "bun:test";
import { VMError, VMErrorCode } from "../src/index";
import { parseProgram } from "../src/parser";

describe("parser", () => {
  test("parses scripts by default without executing source", () => {
    const marker = "__jsvmParserShouldNotExecute";
    delete (globalThis as Record<string, unknown>)[marker];

    const program = parseProgram(
      `globalThis.${marker} = true; const value = 1 + 2; value;`,
    );

    expect(program.type).toBe("Program");
    expect(program.sourceType).toBe("script");
    expect(program.body).toHaveLength(3);
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
  });

  test("parses module syntax only when module source type is requested", () => {
    expect(() => parseProgram("export const value = 1;")).toThrow(VMError);

    const program = parseProgram("export const value = 1;", {
      sourceType: "module",
      sourceFile: "guest-module.js",
    });

    expect(program.sourceType).toBe("module");
    expect(program.loc?.source).toBe("guest-module.js");
  });

  test("normalizes parser failures to VM syntax errors", () => {
    try {
      parseProgram("const =");
    } catch (error) {
      expect(error).toBeInstanceOf(VMError);
      expect((error as VMError).code).toBe(VMErrorCode.VMSyntaxError);
      expect((error as VMError).details.reason).toContain("line 1");
      return;
    }

    throw new Error("Expected parseProgram to throw a VMError.");
  });
});
