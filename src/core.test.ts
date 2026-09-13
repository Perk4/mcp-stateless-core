import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HEADER_MISMATCH,
  INVALID_PARAMS,
  INVALID_REQUEST,
  PROTOCOL_VERSION,
  assertStateless,
  discover,
  enforceHeaders,
  parseRequest,
  type StatelessServer,
} from "./core.ts";

const SERVER: StatelessServer = {
  name: "example-server",
  version: "1.0.0",
  capabilities: { tools: {}, resources: {} },
  instructions: "Call tools without a handshake.",
};

const SEARCH_REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {
    name: "search",
    arguments: { q: "otters" },
    _meta: {
      "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
      "io.modelcontextprotocol/clientInfo": {
        name: "example-client",
        version: "1.0.0",
      },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  },
};

const SEARCH_HEADERS = {
  "MCP-Protocol-Version": PROTOCOL_VERSION,
  "Mcp-Method": "tools/call",
  "Mcp-Name": "search",
};

test("assertStateless: mismatch rejects, discover needs no handshake, session id rejects", () => {
  assertStateless({
    server: SERVER,
    request: SEARCH_REQUEST,
    headers: SEARCH_HEADERS,
  });
});

test("parseRequest: requires _meta protocolVersion and clientInfo", () => {
  const ok = parseRequest(SEARCH_REQUEST);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.request.method, "tools/call");
    assert.equal(ok.request.name, "search");
    assert.equal(ok.request.meta.protocolVersion, PROTOCOL_VERSION);
    assert.equal(ok.request.meta.clientInfo.name, "example-client");
  }

  const noMeta = parseRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "search" },
  });
  assert.equal(noMeta.ok, false);
  if (!noMeta.ok) {
    assert.equal(noMeta.error.kind, "missing-meta");
    assert.equal(noMeta.error.code, INVALID_PARAMS);
  }

  const noClient = parseRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "search",
      _meta: {
        "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
      },
    },
  });
  assert.equal(noClient.ok, false);
  if (!noClient.ok) {
    assert.equal(noClient.error.kind, "missing-meta");
  }
});

test("parseRequest: rejects a session-id field anywhere in the request", () => {
  const top = parseRequest({ ...SEARCH_REQUEST, sessionId: "abc" });
  assert.equal(top.ok, false);
  if (!top.ok) {
    assert.equal(top.error.kind, "session-id");
    assert.equal(top.error.code, INVALID_REQUEST);
  }

  const nested = parseRequest({
    ...SEARCH_REQUEST,
    params: {
      ...SEARCH_REQUEST.params,
      _meta: {
        ...SEARCH_REQUEST.params._meta,
        "mcp-session-id": "sticky",
      },
    },
  });
  assert.equal(nested.ok, false);
  if (!nested.ok) {
    assert.equal(nested.error.kind, "session-id");
  }
});

test("enforceHeaders: requires Mcp-Method and Mcp-Name and rejects disagreement", () => {
  const parsed = parseRequest(SEARCH_REQUEST);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }

  const ok = enforceHeaders(SEARCH_HEADERS, parsed.request);
  assert.equal(ok.ok, true);

  const wrongName = enforceHeaders(
    { ...SEARCH_HEADERS, "Mcp-Name": "weather" },
    parsed.request,
  );
  assert.equal(wrongName.ok, false);
  if (!wrongName.ok) {
    assert.equal(wrongName.error.kind, "header-mismatch");
    assert.equal(wrongName.error.code, HEADER_MISMATCH);
  }

  const missingMethod = enforceHeaders(
    { "Mcp-Name": "search" },
    parsed.request,
  );
  assert.equal(missingMethod.ok, false);
  if (!missingMethod.ok) {
    assert.equal(missingMethod.error.code, HEADER_MISMATCH);
  }

  const sessionHeader = enforceHeaders(
    { ...SEARCH_HEADERS, "Mcp-Session-Id": "legacy" },
    parsed.request,
  );
  assert.equal(sessionHeader.ok, false);
  if (!sessionHeader.ok) {
    assert.equal(sessionHeader.error.kind, "session-id");
  }
});

test("discover: returns static capabilities with no handshake and no session", () => {
  const result = discover(SERVER);
  assert.equal(result.resultType, "complete");
  assert.deepEqual(result.supportedVersions, [PROTOCOL_VERSION]);
  assert.deepEqual(result.capabilities, SERVER.capabilities);
  assert.equal(result.instructions, SERVER.instructions);
  assert.equal(result._meta["io.modelcontextprotocol/serverInfo"].name, SERVER.name);
  assert.equal("sessionId" in result, false);
});
