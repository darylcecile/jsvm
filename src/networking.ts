import { VMError, VMErrorCode, type VMSerializableValue } from "./boundary";
import {
  get as getVMObjectProperty,
  getOwnPropertyDescriptor,
  isVMObject,
  ownKeys,
  set as setVMObjectProperty,
  type VMObject,
} from "./interpreter/object-model";
import { createNativeCallable, type VMNativeCallableTools } from "./interpreter/values";
import type { HttpMethod, NetworkRuleDefinition, PathGlob } from "./network-rule";

export interface HostNetworkRequest {
  readonly url: string;
  readonly method: HttpMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface HostNetworkResponse {
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly redirected: boolean;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyText: string;
}

type VMRecord = Record<string, unknown> | VMObject;

const DEFAULT_METHOD = "GET" satisfies HttpMethod;
const XHR_DONE = 4;

export function createNetworkGlobals(
  rules: readonly NetworkRuleDefinition[],
): Readonly<Record<"fetch" | "XMLHttpRequest", unknown>> {
  return Object.freeze({
    fetch: createNativeCallable("fetch", async (args) =>
      createFetchResponse(await performHostNetworkRequest(args, rules)),
    ),
    XMLHttpRequest: createXMLHttpRequestConstructor(rules),
  });
}

export async function performHostNetworkRequest(
  args: readonly unknown[],
  rules: readonly NetworkRuleDefinition[],
): Promise<HostNetworkResponse> {
  const request = createHostNetworkRequest(args);
  const allowedRequest = applyNetworkRules(request, rules);
  const fetchFn = globalThis.fetch;

  if (typeof fetchFn !== "function") {
    throw new VMError(
      VMErrorCode.VMRuntimeError,
      "Host fetch is not available for VM networking.",
      { reason: "host fetch unavailable" },
    );
  }

  const response = await fetchFn(allowedRequest.url, {
    method: allowedRequest.method,
    headers: allowedRequest.headers,
    body: allowedRequest.body,
  });
  const headers: Record<string, string> = Object.create(null);

  response.headers.forEach((value, name) => {
    headers[name] = value;
  });

  return Object.freeze({
    url: response.url,
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    redirected: response.redirected,
    headers: Object.freeze(headers),
    bodyText: await response.text(),
  });
}

function createHostNetworkRequest(args: readonly unknown[]): HostNetworkRequest {
  const url = normalizeRequestUrl(args[0]);
  const init = isRecordObject(args[1]) ? args[1] : undefined;
  const method = normalizeRequestMethod(
    init === undefined ? undefined : getRecordProperty(init, "method"),
  );
  const headers = normalizeRequestHeaders(
    init === undefined ? undefined : getRecordProperty(init, "headers"),
  );
  const body = normalizeRequestBody(
    init === undefined ? undefined : getRecordProperty(init, "body"),
  );

  return Object.freeze({
    url: url.href,
    method,
    headers,
    body,
  });
}

function applyNetworkRules(
  request: HostNetworkRequest,
  rules: readonly NetworkRuleDefinition[],
): HostNetworkRequest {
  const url = new URL(request.url);

  for (const rule of rules) {
    if (!hostMatches(rule.host, url) || !methodMatches(rule, request.method) || !pathMatches(rule, url.pathname)) {
      continue;
    }

    return Object.freeze({
      ...request,
      headers: Object.freeze({
        ...request.headers,
        ...rule.headers,
      }),
    });
  }

  throw new VMError(
    VMErrorCode.VMSecurityError,
    `VM network request to ${url.host}${url.pathname} is not allowed by networkRules.`,
    {
      reason: "network rule denied",
      path: `${request.method} ${url.href}`,
    },
  );
}

function createFetchResponse(response: HostNetworkResponse): VMRecord {
  const headers = createHeadersObject(response.headers);

  return Object.assign(Object.create(null), {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    redirected: response.redirected,
    headers,
    text: createNativeCallable("Response.text", () => response.bodyText),
    json: createNativeCallable("Response.json", () => parseResponseJson(response.bodyText)),
    arrayBuffer: createNativeCallable("Response.arrayBuffer", () => textToArrayBuffer(response.bodyText)),
  });
}

function createHeadersObject(headers: Readonly<Record<string, string>>): VMRecord {
  const normalized = normalizeHeaderRecord(headers);

  return Object.assign(Object.create(null), {
    get: createNativeCallable("Headers.get", ([name]) => normalized[String(name).toLowerCase()] ?? null),
    has: createNativeCallable("Headers.has", ([name]) => Object.hasOwn(normalized, String(name).toLowerCase())),
    entries: createNativeCallable("Headers.entries", () => Object.entries(normalized)),
    toJSON: createNativeCallable("Headers.toJSON", () => ({ ...normalized })),
  });
}

function createXMLHttpRequestConstructor(rules: readonly NetworkRuleDefinition[]): unknown {
  return createNativeCallable(
    "XMLHttpRequest",
    () => {
      throw new VMError(
        VMErrorCode.VMRuntimeError,
        "XMLHttpRequest must be constructed with new.",
        { reason: "constructor required" },
      );
    },
    {
      construct: () => createXMLHttpRequestInstance(rules),
    },
  );
}

function createXMLHttpRequestInstance(rules: readonly NetworkRuleDefinition[]): VMRecord {
  let method: HttpMethod = DEFAULT_METHOD;
  let url = "";
  let requestHeaders: Record<string, string> = Object.create(null);
  const responseHeaders: { current: Readonly<Record<string, string>> } = {
    current: Object.freeze(Object.create(null) as Record<string, string>),
  };

  return Object.assign(Object.create(null), {
    UNSENT: 0,
    OPENED: 1,
    HEADERS_RECEIVED: 2,
    LOADING: 3,
    DONE: XHR_DONE,
    readyState: 0,
    status: 0,
    statusText: "",
    responseURL: "",
    responseText: "",
    response: "",
    onreadystatechange: null,
    onload: null,
    onerror: null,
    onloadend: null,
    open: createNativeCallable("XMLHttpRequest.open", ([nextMethod, nextUrl], _context, thisValue) => {
      const xhr = asXHRRecord(thisValue);
      method = normalizeRequestMethod(nextMethod);
      url = normalizeRequestUrl(nextUrl).href;
      requestHeaders = Object.create(null);
      responseHeaders.current = Object.freeze(Object.create(null) as Record<string, string>);
      setRecordProperty(xhr, "readyState", 1);
      setRecordProperty(xhr, "status", 0);
      setRecordProperty(xhr, "statusText", "");
      setRecordProperty(xhr, "responseURL", "");
      setRecordProperty(xhr, "responseText", "");
      setRecordProperty(xhr, "response", "");
      return undefined;
    }),
    setRequestHeader: createNativeCallable("XMLHttpRequest.setRequestHeader", ([name, value]) => {
      assertHeaderName(String(name));
      requestHeaders[String(name)] = String(value);
      return undefined;
    }),
    getResponseHeader: createNativeCallable("XMLHttpRequest.getResponseHeader", ([name]) =>
      normalizeHeaderRecord(responseHeaders.current)[String(name).toLowerCase()] ?? null,
    ),
    getAllResponseHeaders: createNativeCallable("XMLHttpRequest.getAllResponseHeaders", () =>
      Object.entries(responseHeaders.current)
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join(""),
    ),
    send: createNativeCallable("XMLHttpRequest.send", async ([body], context, thisValue, tools) => {
      const xhr = asXHRRecord(thisValue);

      try {
        setRecordProperty(xhr, "readyState", 2);
        await dispatchXHREvent(xhr, "readystatechange", context, tools);
        const response = await performHostNetworkRequest(
          [url, {
            method,
            headers: requestHeaders,
            body: normalizeRequestBody(body),
          }],
          rules,
        );
        responseHeaders.current = response.headers;
        setRecordProperty(xhr, "readyState", 3);
        await dispatchXHREvent(xhr, "readystatechange", context, tools);
        setRecordProperty(xhr, "readyState", XHR_DONE);
        setRecordProperty(xhr, "status", response.status);
        setRecordProperty(xhr, "statusText", response.statusText);
        setRecordProperty(xhr, "responseURL", response.url);
        setRecordProperty(xhr, "responseText", response.bodyText);
        setRecordProperty(xhr, "response", response.bodyText);
        await dispatchXHREvent(xhr, "readystatechange", context, tools);
        await dispatchXHREvent(xhr, "load", context, tools);
        await dispatchXHREvent(xhr, "loadend", context, tools);
      } catch (error) {
        setRecordProperty(xhr, "readyState", XHR_DONE);
        await dispatchXHREvent(xhr, "readystatechange", context, tools);
        await dispatchXHREvent(xhr, "error", context, tools);
        await dispatchXHREvent(xhr, "loadend", context, tools);
        throw error;
      }

      return undefined;
    }),
  });
}

async function dispatchXHREvent(
  xhr: VMRecord,
  type: "readystatechange" | "load" | "error" | "loadend",
  context: unknown,
  tools: VMNativeCallableTools,
): Promise<void> {
  const handler = getRecordProperty(xhr, `on${type}`);

  if (handler === null || handler === undefined) {
    return;
  }

  await tools.invokeGuestCallable(handler, [Object.freeze({ type })]);
}

function normalizeRequestUrl(value: unknown): URL {
  if (typeof value !== "string") {
    throw new VMError(
      VMErrorCode.VMRuntimeError,
      "VM network request URL must be a string.",
      { valueType: typeof value },
    );
  }

  try {
    const url = new URL(value);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TypeError("unsupported protocol");
    }

    return url;
  } catch {
    throw new VMError(
      VMErrorCode.VMRuntimeError,
      `Invalid VM network request URL "${value}".`,
      { reason: "invalid URL" },
    );
  }
}

function normalizeRequestMethod(value: unknown): HttpMethod {
  const method = value === undefined ? DEFAULT_METHOD : String(value).toUpperCase();

  if (!isHttpMethod(method)) {
    throw new VMError(
      VMErrorCode.VMRuntimeError,
      `Unsupported VM network request method "${method}".`,
      { reason: "unsupported method" },
    );
  }

  return method;
}

function normalizeRequestHeaders(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined || value === null) {
    return Object.freeze(Object.create(null) as Record<string, string>);
  }

  if (!isRecordObject(value)) {
    throw new VMError(
      VMErrorCode.VMRuntimeError,
      "VM network request headers must be a plain object.",
      { reason: "invalid headers" },
    );
  }

  const headers: Record<string, string> = Object.create(null);

  for (const [name, headerValue] of getRecordEntries(value)) {
    assertHeaderName(name);
    headers[name] = String(headerValue);
  }

  return Object.freeze(headers);
}

function normalizeRequestBody(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }

  throw new VMError(
    VMErrorCode.VMRuntimeError,
    "VM network request bodies must be primitive serializable values.",
    { reason: "unsupported body" },
  );
}

function hostMatches(ruleHost: string, url: URL): boolean {
  return ruleHost === url.hostname.toLowerCase() || ruleHost === url.host.toLowerCase();
}

function methodMatches(rule: NetworkRuleDefinition, method: HttpMethod): boolean {
  const methods = rule.allow.methods;

  if (methods === "all") {
    return true;
  }

  if (methods === "none") {
    return false;
  }

  return methods.includes(method);
}

function pathMatches(rule: NetworkRuleDefinition, path: string): boolean {
  const paths = rule.allow.paths;

  if (paths === "all") {
    return true;
  }

  if (paths === "none") {
    return false;
  }

  return paths.some((glob) => pathGlobMatches(glob, path));
}

function pathGlobMatches(glob: PathGlob, path: string): boolean {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

function parseResponseJson(text: string): VMSerializableValue {
  try {
    return JSON.parse(text) as VMSerializableValue;
  } catch {
    throw new VMError(
      VMErrorCode.VMRuntimeError,
      "VM Response.json() could not parse the response body.",
      { reason: "invalid JSON" },
    );
  }
}

function textToArrayBuffer(text: string): ArrayBuffer {
  const bytes = new Uint8Array(text.length);

  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index) & 0xff;
  }

  return bytes.buffer;
}

function normalizeHeaderRecord(headers: Readonly<Record<string, string>>): Record<string, string> {
  const normalized: Record<string, string> = Object.create(null);

  for (const [name, value] of Object.entries(headers)) {
    normalized[name.toLowerCase()] = value;
  }

  return normalized;
}

function assertHeaderName(name: string): void {
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
    throw new VMError(
      VMErrorCode.VMRuntimeError,
      `Invalid VM network request header name "${name}".`,
      { reason: "invalid header" },
    );
  }
}

function isHttpMethod(method: string): method is HttpMethod {
  return method === "GET" ||
    method === "HEAD" ||
    method === "POST" ||
    method === "PUT" ||
    method === "PATCH" ||
    method === "DELETE" ||
    method === "OPTIONS" ||
    method === "TRACE" ||
    method === "CONNECT";
}

function asXHRRecord(value: unknown): VMRecord {
  if (!isRecordObject(value)) {
    throw new VMError(
      VMErrorCode.VMRuntimeError,
      "XMLHttpRequest method called with an invalid receiver.",
      { reason: "invalid receiver" },
    );
  }

  return value;
}

function isRecordObject(value: unknown): value is VMRecord {
  return isPlainObject(value) || isVMObject(value);
}

function getRecordProperty(record: VMRecord, key: string): unknown {
  return isVMObject(record) ? getVMObjectProperty(record, key) : record[key];
}

function setRecordProperty(record: VMRecord, key: string, value: unknown): void {
  if (isVMObject(record)) {
    if (!setVMObjectProperty(record, key, value)) {
      throw new VMError(
        VMErrorCode.VMRuntimeError,
        `Unable to set XMLHttpRequest property "${key}".`,
        { path: key, reason: "property set failed" },
      );
    }
    return;
  }

  record[key] = value;
}

function getRecordEntries(record: VMRecord): [string, unknown][] {
  if (!isVMObject(record)) {
    return Object.entries(record);
  }

  const entries: [string, unknown][] = [];

  for (const key of ownKeys(record)) {
    if (typeof key !== "string") {
      continue;
    }

    const descriptor = getOwnPropertyDescriptor(record, key);
    if (descriptor?.enumerable === true) {
      entries.push([key, getVMObjectProperty(record, key)]);
    }
  }

  return entries;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
