import assert from "node:assert/strict";

export const PROTOCOL_VERSION = "2026-07-28";

export const HEADER_MISMATCH = -32020;
export const INVALID_REQUEST = -32600;
export const INVALID_PARAMS = -32602;

export type Implementation = {
  name: string;
  version: string;
};

export type RequestMeta = {
  protocolVersion: string;
  clientInfo: Implementation;
  clientCapabilities: Record<string, unknown>;
};

export type StatelessRequest = {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  name: string;
  params: Record<string, unknown>;
  meta: RequestMeta;
};

export type StatelessServer = {
  name: string;
  version: string;
  capabilities: Record<string, unknown>;
  instructions?: string;
  supportedVersions?: readonly string[];
};

export type DiscoverResult = {
  resultType: "complete";
  supportedVersions: string[];
  capabilities: Record<string, unknown>;
  instructions?: string;
  ttlMs: number;
  cacheScope: "public";
  _meta: {
    "io.modelcontextprotocol/serverInfo": Implementation;
  };
};

export type StatelessError =
  | { kind: "invalid-request"; code: typeof INVALID_REQUEST; message: string }
  | { kind: "missing-meta"; code: typeof INVALID_PARAMS; message: string }
  | { kind: "header-mismatch"; code: typeof HEADER_MISMATCH; message: string }
  | { kind: "session-id"; code: typeof INVALID_REQUEST; message: string };

export type ParseResult =
  | { ok: true; request: StatelessRequest }
  | { ok: false; error: StatelessError };

export type HeaderResult =
  | { ok: true }
  | { ok: false; error: StatelessError };

export type HeadersLike =
  | Headers
  | Record<string, string | readonly string[] | undefined>;

export type StatelessFixture = {
  server: StatelessServer;
  request: unknown;
  headers: HeadersLike;
};

const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

const SESSION_KEY = /^(mcp)?sessionid$/i;

/**
 * Parse a self-describing JSON-RPC-ish MCP request.
 * Requires `_meta` protocolVersion + clientInfo. Rejects any session-id field.
 */
export function parseRequest(raw: unknown): ParseResult {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return fail("invalid-request", "body is not valid JSON");
    }
  }

  if (hasSessionIdField(value)) {
    return fail("session-id", "session identifiers are not part of MCP 2026-07-28");
  }

  if (!isObject(value)) {
    return fail("invalid-request", "request must be an object");
  }

  if (value.jsonrpc !== "2.0") {
    return fail("invalid-request", "jsonrpc must be \"2.0\"");
  }

  if (!isId(value.id)) {
    return fail("invalid-request", "id must be a string or number");
  }

  if (typeof value.method !== "string" || value.method.length === 0) {
    return fail("invalid-request", "method must be a non-empty string");
  }

  if (!isObject(value.params)) {
    return fail("invalid-request", "params must be an object");
  }

  const metaRaw = value.params._meta ?? value._meta;
  const meta = parseMeta(metaRaw);
  if (!meta.ok) {
    return meta;
  }

  return {
    ok: true,
    request: {
      jsonrpc: "2.0",
      id: value.id,
      method: value.method,
      name: bodyName(value.params),
      params: value.params,
      meta: meta.meta,
    },
  };
}

/**
 * Require `Mcp-Method` and `Mcp-Name`. Reject when they disagree with the body.
 * Also reject a leftover `Mcp-Session-Id` header.
 */
export function enforceHeaders(headers: HeadersLike, body: StatelessRequest): HeaderResult {
  if (headerValue(headers, "mcp-session-id") !== undefined) {
    return fail("session-id", "Mcp-Session-Id is not part of MCP 2026-07-28");
  }

  const methodHeader = headerValue(headers, "mcp-method");
  if (methodHeader === undefined) {
    return mismatch("Mcp-Method header is required");
  }
  if (methodHeader !== body.method) {
    return mismatch(
      `Header mismatch: Mcp-Method header value '${methodHeader}' does not match body value '${body.method}'`,
    );
  }

  const nameHeader = headerValue(headers, "mcp-name");
  if (nameHeader === undefined) {
    return mismatch("Mcp-Name header is required");
  }
  if (nameHeader !== body.name) {
    return mismatch(
      `Header mismatch: Mcp-Name header value '${nameHeader}' does not match body value '${body.name}'`,
    );
  }

  const versionHeader = headerValue(headers, "mcp-protocol-version");
  if (versionHeader !== undefined && versionHeader !== body.meta.protocolVersion) {
    return mismatch(
      `Header mismatch: MCP-Protocol-Version header value '${versionHeader}' does not match body value '${body.meta.protocolVersion}'`,
    );
  }

  return { ok: true };
}

/**
 * `server/discover` as a pure function over static server data.
 * No initialize/initialized handshake. No sticky session.
 */
export function discover(server: StatelessServer): DiscoverResult {
  const result: DiscoverResult = {
    resultType: "complete",
    supportedVersions: [...(server.supportedVersions ?? [PROTOCOL_VERSION])],
    capabilities: server.capabilities,
    ttlMs: 3_600_000,
    cacheScope: "public",
    _meta: {
      [META_SERVER_INFO]: {
        name: server.name,
        version: server.version,
      },
    },
  };
  if (server.instructions !== undefined) {
    result.instructions = server.instructions;
  }
  return result;
}

/**
 * Fixture assertions for the stateless shape:
 * (a) header/body mismatch rejects,
 * (b) discover works with no prior handshake,
 * (c) a request carrying a session id rejects.
 */
export function assertStateless(fixture: StatelessFixture): void {
  const parsed = parseRequest(fixture.request);
  assert.equal(parsed.ok, true, expectedOk("fixture request", parsed));
  if (!parsed.ok) {
    return;
  }

  const matched = enforceHeaders(fixture.headers, parsed.request);
  assert.equal(matched.ok, true, expectedOk("fixture headers", matched));

  const mismatchedName = parsed.request.name.length > 0 ? `not-${parsed.request.name}` : "mismatch";
  const mismatch = enforceHeaders(
    {
      ...plainHeaders(fixture.headers),
      "mcp-name": mismatchedName,
    },
    parsed.request,
  );
  assert.equal(mismatch.ok, false, "header/body mismatch must reject");
  if (!mismatch.ok) {
    assert.equal(mismatch.error.kind, "header-mismatch");
    assert.equal(mismatch.error.code, HEADER_MISMATCH);
  }

  const found = discover(fixture.server);
  assert.equal(found.resultType, "complete");
  assert.ok(
    found.supportedVersions.includes(PROTOCOL_VERSION),
    "discover must advertise 2026-07-28 with no initialize handshake",
  );
  assert.equal(found._meta[META_SERVER_INFO].name, fixture.server.name);
  assert.equal(found._meta[META_SERVER_INFO].version, fixture.server.version);
  assert.equal(hasSessionIdField(found), false);

  const withSession = withSessionId(fixture.request);
  const session = parseRequest(withSession);
  assert.equal(session.ok, false, "request carrying a session id must reject");
  if (!session.ok) {
    assert.equal(session.error.kind, "session-id");
    assert.equal(session.error.code, INVALID_REQUEST);
  }
}

function parseMeta(raw: unknown): { ok: true; meta: RequestMeta } | { ok: false; error: StatelessError } {
  if (!isObject(raw)) {
    return fail("missing-meta", "_meta is required on every request");
  }

  const protocolVersion = raw[META_PROTOCOL_VERSION];
  if (typeof protocolVersion !== "string" || protocolVersion.length === 0) {
    return fail("missing-meta", `${META_PROTOCOL_VERSION} is required`);
  }

  const clientInfoRaw = raw[META_CLIENT_INFO];
  if (!isObject(clientInfoRaw)) {
    return fail("missing-meta", `${META_CLIENT_INFO} is required`);
  }
  if (typeof clientInfoRaw.name !== "string" || clientInfoRaw.name.length === 0) {
    return fail("missing-meta", "clientInfo.name is required");
  }
  if (typeof clientInfoRaw.version !== "string" || clientInfoRaw.version.length === 0) {
    return fail("missing-meta", "clientInfo.version is required");
  }

  const capabilitiesRaw = raw[META_CLIENT_CAPABILITIES];
  if (capabilitiesRaw !== undefined && !isObject(capabilitiesRaw)) {
    return fail("missing-meta", `${META_CLIENT_CAPABILITIES} must be an object`);
  }

  return {
    ok: true,
    meta: {
      protocolVersion,
      clientInfo: {
        name: clientInfoRaw.name,
        version: clientInfoRaw.version,
      },
      clientCapabilities: isObject(capabilitiesRaw) ? capabilitiesRaw : {},
    },
  };
}

function bodyName(params: Record<string, unknown>): string {
  if (typeof params.name === "string") {
    return params.name;
  }
  if (typeof params.uri === "string") {
    return params.uri;
  }
  return "";
}

function headerValue(headers: HeadersLike, name: string): string | undefined {
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const value = headers.get(name);
    return value === null ? undefined : value;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) {
      continue;
    }
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value) && typeof value[0] === "string") {
      return value[0];
    }
  }
  return undefined;
}

function plainHeaders(headers: HeadersLike): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      out[key.toLowerCase()] = value;
    } else if (Array.isArray(value) && typeof value[0] === "string") {
      out[key.toLowerCase()] = value[0];
    }
  }
  return out;
}

function withSessionId(raw: unknown): unknown {
  const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!isObject(value)) {
    return { sessionId: "legacy-session" };
  }
  return { ...value, sessionId: "legacy-session" };
}

function hasSessionIdField(value: unknown, seen: Set<object> = new Set()): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((item) => hasSessionIdField(item, seen));
  }

  for (const [key, nested] of Object.entries(value)) {
    if (SESSION_KEY.test(key.replace(/[-_]/g, ""))) {
      return true;
    }
    if (hasSessionIdField(nested, seen)) {
      return true;
    }
  }
  return false;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function mismatch(message: string): HeaderResult {
  return fail("header-mismatch", message);
}

function fail(kind: "invalid-request", message: string): { ok: false; error: StatelessError };
function fail(kind: "missing-meta", message: string): { ok: false; error: StatelessError };
function fail(kind: "header-mismatch", message: string): { ok: false; error: StatelessError };
function fail(kind: "session-id", message: string): { ok: false; error: StatelessError };
function fail(kind: StatelessError["kind"], message: string): { ok: false; error: StatelessError } {
  switch (kind) {
    case "invalid-request":
      return { ok: false, error: { kind, code: INVALID_REQUEST, message } };
    case "missing-meta":
      return { ok: false, error: { kind, code: INVALID_PARAMS, message } };
    case "header-mismatch":
      return { ok: false, error: { kind, code: HEADER_MISMATCH, message } };
    case "session-id":
      return { ok: false, error: { kind, code: INVALID_REQUEST, message } };
    default: {
      const _exhaustive: never = kind;
      throw _exhaustive;
    }
  }
}

function expectedOk(label: string, result: ParseResult | HeaderResult): string {
  if (result.ok) {
    return `${label} ok`;
  }
  return `${label} failed: ${result.error.message}`;
}
