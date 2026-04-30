const SUPPORTED_HTTP_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "TRACE",
  "CONNECT",
] as const;

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;

export type HttpMethod = (typeof SUPPORTED_HTTP_METHODS)[number];
export type PathGlob = `/${string}`;
export type NetworkRuleScope<T> = "all" | "none" | readonly T[];
export type NetworkRuleHeaders = Readonly<Record<string, string>>;

export interface NetworkRuleAllowOptions {
  readonly methods?: readonly HttpMethod[];
  readonly paths?: readonly PathGlob[];
}

export interface NetworkRuleAllowDefinition {
  readonly methods: NetworkRuleScope<HttpMethod>;
  readonly paths: NetworkRuleScope<PathGlob>;
}

export interface NetworkRuleDefinition {
  readonly type: "network-rule";
  readonly host: string;
  readonly allow: NetworkRuleAllowDefinition;
  readonly headers: NetworkRuleHeaders;
}

export interface NetworkRuleBuilder {
  readonly type: "network-rule";
  readonly host: string;
  readonly methods: NetworkRuleScope<HttpMethod>;
  readonly paths: NetworkRuleScope<PathGlob>;
  readonly headers: NetworkRuleHeaders;
  allow(options?: NetworkRuleAllowOptions): NetworkRuleBuilder;
  setHeaders(headers: NetworkRuleHeaders): NetworkRuleBuilder;
  toJSON(): NetworkRuleDefinition;
}

export const HTTP_METHODS: readonly HttpMethod[] = Object.freeze([
  ...SUPPORTED_HTTP_METHODS,
]);

const HTTP_METHOD_SET: ReadonlySet<string> = new Set(SUPPORTED_HTTP_METHODS);

export function networkRule(host: string): NetworkRuleBuilder {
  return createNetworkRuleBuilder(
    normalizeHost(host),
    "none",
    "none",
    freezeHeaders({}),
  );
}

function createNetworkRuleBuilder(
  host: string,
  methods: NetworkRuleScope<HttpMethod>,
  paths: NetworkRuleScope<PathGlob>,
  headers: NetworkRuleHeaders,
): NetworkRuleBuilder {
  const allow: NetworkRuleAllowDefinition = Object.freeze({
    methods,
    paths,
  });
  const definition: NetworkRuleDefinition = Object.freeze({
    type: "network-rule",
    host,
    allow,
    headers,
  });
  const builder = {
    type: "network-rule" as const,
    host,
    methods,
    paths,
    headers,
  };

  Object.defineProperties(builder, {
    allow: {
      value: (options?: NetworkRuleAllowOptions) =>
        createNetworkRuleBuilder(
          host,
          normalizeMethods(options),
          normalizePaths(options),
          headers,
        ),
    },
    setHeaders: {
      value: (nextHeaders: NetworkRuleHeaders) =>
        createNetworkRuleBuilder(
          host,
          methods,
          paths,
          freezeHeaders(nextHeaders),
        ),
    },
    toJSON: {
      value: () => definition,
    },
  });

  return Object.freeze(builder) as NetworkRuleBuilder;
}

function normalizeHost(host: string): string {
  if (typeof host !== "string") {
    throw new TypeError("networkRule host must be a string.");
  }

  if (host.length === 0) {
    throw new RangeError("networkRule host must not be empty.");
  }

  if (host !== host.trim()) {
    throw new RangeError("networkRule host must not include surrounding whitespace.");
  }

  if (
    host.includes("://") ||
    host.includes("/") ||
    host.includes("?") ||
    host.includes("#") ||
    host.includes("@") ||
    /\s/.test(host) ||
    CONTROL_CHARACTER_PATTERN.test(host)
  ) {
    throw new RangeError(
      "networkRule host must be a host name only, without a scheme, path, query, fragment, credentials, or whitespace.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(`https://${host}`);
  } catch {
    throw new RangeError(`Invalid networkRule host "${host}".`);
  }

  if (parsed.hostname.length === 0) {
    throw new RangeError(`Invalid networkRule host "${host}".`);
  }

  return host.toLowerCase();
}

function normalizeMethods(
  options?: NetworkRuleAllowOptions,
): NetworkRuleScope<HttpMethod> {
  const methods = normalizeAllowOptions(options).methods;

  if (methods === undefined) {
    return "all";
  }

  if (!Array.isArray(methods)) {
    throw new TypeError("networkRule allow methods must be an array of HTTP methods.");
  }

  if (methods.length === 0) {
    throw new RangeError("networkRule allow methods must not be empty.");
  }

  return Object.freeze(
    methods.map((method) => {
      if (typeof method !== "string" || !isHttpMethod(method)) {
        throw new RangeError(
          `Invalid networkRule HTTP method "${String(method)}". Supported methods are ${HTTP_METHODS.join(", ")}.`,
        );
      }

      return method;
    }),
  );
}

function normalizePaths(
  options?: NetworkRuleAllowOptions,
): NetworkRuleScope<PathGlob> {
  const paths = normalizeAllowOptions(options).paths;

  if (paths === undefined) {
    return "all";
  }

  if (!Array.isArray(paths)) {
    throw new TypeError("networkRule allow paths must be an array of path globs.");
  }

  if (paths.length === 0) {
    throw new RangeError("networkRule allow paths must not be empty.");
  }

  return Object.freeze(
    paths.map((path) => {
      if (typeof path !== "string") {
        throw new TypeError("networkRule allow paths must only contain strings.");
      }

      if (!path.startsWith("/")) {
        throw new RangeError(
          `Invalid networkRule path glob "${path}". Path globs must start with "/".`,
        );
      }

      if (
        path.length === 0 ||
        path.includes("?") ||
        path.includes("#") ||
        CONTROL_CHARACTER_PATTERN.test(path)
      ) {
        throw new RangeError(
          `Invalid networkRule path glob "${path}". Path globs must be paths without query strings, fragments, or control characters.`,
        );
      }

      return path as PathGlob;
    }),
  );
}

function normalizeAllowOptions(
  options?: NetworkRuleAllowOptions,
): NetworkRuleAllowOptions {
  if (options === undefined) {
    return {};
  }

  if (!isPlainObject(options)) {
    throw new TypeError("networkRule allow options must be an object.");
  }

  for (const key of Object.keys(options)) {
    if (key !== "methods" && key !== "paths") {
      throw new TypeError(`Unknown networkRule allow option "${key}".`);
    }
  }

  return options;
}

function freezeHeaders(headers: NetworkRuleHeaders): NetworkRuleHeaders {
  if (!isPlainObject(headers)) {
    throw new TypeError("networkRule headers must be a plain object.");
  }

  const normalizedHeaders: Record<string, string> = {};
  const seenNames = new Set<string>();

  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME_PATTERN.test(name)) {
      throw new RangeError(
        `Invalid networkRule header name "${name}". Header names must be valid HTTP token names.`,
      );
    }

    const lowerName = name.toLowerCase();
    if (seenNames.has(lowerName)) {
      throw new RangeError(
        `Duplicate networkRule header name "${name}". Header names are case-insensitive.`,
      );
    }
    seenNames.add(lowerName);

    if (typeof value !== "string") {
      throw new TypeError(`networkRule header "${name}" value must be a string.`);
    }

    if (/[\r\n]/.test(value)) {
      throw new RangeError(
        `Invalid networkRule header "${name}" value. Header values must not contain CR or LF characters.`,
      );
    }

    Object.defineProperty(normalizedHeaders, name, {
      value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }

  return Object.freeze(normalizedHeaders);
}

function isHttpMethod(method: string): method is HttpMethod {
  return HTTP_METHOD_SET.has(method);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
