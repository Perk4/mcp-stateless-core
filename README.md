# mcp-stateless-core

Tiny TypeScript core of MCP **2026-07-28**'s stateless shape: parse `_meta`, enforce routing headers, discover without a handshake, reject sessions.

This is not an MCP SDK, not an agent host, and not a product gateway. It teaches the protocol shape.

Source itch: [Better Stack — MCP Was Wrong From The Start (They Just Fixed It)](https://www.youtube.com/watch?v=f4mI3d-nTrI). Spec notes: [2026-07-28](https://blog.modelcontextprotocol.io/posts/2026-07-28/).

## The four primitives

All four live in `src/core.ts`.

1. **`parseRequest(raw)`** — A JSON-RPC-ish request must carry `_meta` on every call: `io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientInfo`. Any session-id field is rejected. There is no `initialize` / `initialized` exchange.
2. **`enforceHeaders(headers, body)`** — Streamable HTTP requires `Mcp-Method` and `Mcp-Name`. They must match `method` and `params.name` (or `params.uri`). Disagreement is `HeaderMismatch` (`-32020`). A leftover `Mcp-Session-Id` header is rejected.
3. **`discover(server)`** — `server/discover` as a pure function. Returns static `supportedVersions`, `capabilities`, and `serverInfo`. No handshake. No sticky session.
4. **`assertStateless(fixture)`** — The three checks that lock the shape: (a) header/body mismatch rejects, (b) discover succeeds with no prior handshake, (c) a request carrying a session id rejects.

## Spec map (2026-07-28)

| Primitive | Spec shape |
| --- | --- |
| `parseRequest` | SEP-2575: every request is self-describing. Protocol version and client identity travel in `_meta`, not in a connection handshake. |
| `enforceHeaders` | SEP-2243: `Mcp-Method` / `Mcp-Name` so a gateway can route without parsing the body. Mismatch → HTTP 400 + `-32020`. |
| `discover` | SEP-2575: `server/discover` is optional for clients, required of servers. Capabilities are static. Any instance can answer. |
| `assertStateless` | SEP-2567: `Mcp-Session-Id` is gone. This core **rejects** a session id so the absence is testable. The official transport would ignore the header; the lesson here is "do not carry one." |

A matching tool call looks like:

```http
POST /mcp HTTP/1.1
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call
Mcp-Name: search

{"jsonrpc":"2.0","id":1,"method":"tools/call",
 "params":{"name":"search","arguments":{"q":"otters"},
 "_meta":{
   "io.modelcontextprotocol/protocolVersion":"2026-07-28",
   "io.modelcontextprotocol/clientInfo":{"name":"example-client","version":"1.0.0"}
 }}}
```

`discover` does not need that call first. The request above can land on any instance behind a round-robin load balancer.

## Run

Needs Node 22 or newer (type stripping, no build step).

```bash
npm install
npm test
npm run typecheck
```
