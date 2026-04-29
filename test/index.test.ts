import { describe, expect, test } from "bun:test";
import { greet } from "../src/index";

describe("greet", () => {
  test("returns a greeting for the provided name", () => {
    expect(greet({ name: "vmjs" })).toBe("Hello, vmjs!");
  });
});
