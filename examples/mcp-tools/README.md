# mcp-tools

One tool container, served over MCP and bridged back: [`@oribos/mcp-server`](../../packages/mcp-server/)
serves three tools over the protocol, [`@oribos/mcp-client`](../../packages/mcp-client/) connects and turns
the remote list back into the framework's `Record<string, Tool>` — the same shape an agent's `tools:`
takes. Oribos is a TypeScript agent framework with zero runtime dependencies — compose only what you
use, run anywhere.

The example is a single file (`src/index.ts`) that plays both roles in one script, over both transports:
HTTP (default) and stdio (`MCP_TRANSPORT=stdio` re-execs the script as the server child, which the client
package then owns). It asserts its own round-trip (`node:assert/strict`; any violated payoff exits 1):

- **the snapshot** — the bridged container keys equal the remote tool names (`echo`, `weather`, `failing`);
- **text projection** — a tool without an output schema comes back as its joined text;
- **structured projection** — a tool with an output schema returns `structuredContent` verbatim;
- **the negative path** — a remote `isError` result throws, which the agent loop would feed back to the
  model as `Tool 'failing' failed: …`;
- **`prefixTools`** — renaming is a local container transform; the prefix never reaches the wire;
- **`refresh()`** — re-lists and swaps the snapshot; old references stay readable;
- **`close()`** — idempotent, and afterwards calls fail with the SDK's `Not connected`.

## Run

From the repo root:

```bash
pnpm install
pnpm build                 # examples consume the packages through their built exports (dist)
pnpm --filter @oribos/example-mcp-tools start                       # HTTP, ephemeral 127.0.0.1 port
MCP_PORT=8787 pnpm --filter @oribos/example-mcp-tools start         # pin the HTTP port
MCP_TRANSPORT=stdio pnpm --filter @oribos/example-mcp-tools start   # stdio child owned by the client
```

No API key and no network beyond loopback.

## Notes

- The example consumes `@oribos/core`, `@oribos/mcp-server` and `@oribos/mcp-client` through their built
  package exports — run `pnpm build` before `start`.
- Server-side docs: [`packages/mcp-server`](../../packages/mcp-server/) — the MCP server capability
  package (HTTP / Next.js / Hono / `node:http` wiring, Host and Origin protection); client-side docs:
  [`packages/mcp-client`](../../packages/mcp-client/) — the MCP client capability package (transports
  and options, snapshot lifecycle, what crosses the bridge).
