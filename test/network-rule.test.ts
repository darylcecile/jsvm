import { describe, expect, test } from "bun:test";

import { networkRule } from "../src/index";

describe("networkRule", () => {
  test("builds immutable serializable rules with allowed methods, paths, and headers", () => {
    const rule = networkRule("example.com")
      .allow({ methods: ["GET"], paths: ["/api/*", "/home"] })
      .setHeaders({ "X-API-Key": "secret" });

    expect(rule.host).toBe("example.com");
    expect(rule.methods).toEqual(["GET"]);
    expect(rule.paths).toEqual(["/api/*", "/home"]);
    expect(rule.headers).toEqual({ "X-API-Key": "secret" });
    expect(Object.isFrozen(rule)).toBe(true);
    expect(Object.isFrozen(rule.methods)).toBe(true);
    expect(Object.isFrozen(rule.paths)).toBe(true);
    expect(Object.isFrozen(rule.headers)).toBe(true);
    expect(JSON.parse(JSON.stringify(rule))).toEqual({
      type: "network-rule",
      host: "example.com",
      allow: { methods: ["GET"], paths: ["/api/*", "/home"] },
      headers: { "X-API-Key": "secret" },
    });
  });

  test("allows all methods and paths when allow is called without options", () => {
    const rule = networkRule("another.com").allow();

    expect(rule.host).toBe("another.com");
    expect(rule.methods).toBe("all");
    expect(rule.paths).toBe("all");
    expect(rule.headers).toEqual({});
  });

  test("rejects invalid hosts, methods, paths, and headers", () => {
    expect(() => networkRule("")).toThrow("must not be empty");
    expect(() => networkRule("https://example.com")).toThrow("host name only");
    expect(() => networkRule("example.com").allow({ methods: ["get" as never] })).toThrow(
      "Invalid networkRule HTTP method",
    );
    expect(() => networkRule("example.com").allow({ paths: ["api/*" as never] })).toThrow(
      'must start with "/"',
    );
    expect(() => networkRule("example.com").setHeaders({ "Bad Header": "value" })).toThrow(
      "Invalid networkRule header name",
    );
  });
});
