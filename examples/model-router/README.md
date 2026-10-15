# model-router

`'provider/model'` strings routed to model instances against a catalog snapshot — the
model-router capability package over data the application brings.

- **The catalog is a committed cut** of `https://models.dev/api.json` (`src/catalog.json`,
  providers `groq` + `cerebras`; per-model fields trimmed, shape unchanged — a wider cut pastes
  as-is).
- **The provider packages are teaching stubs** standing in for `@ai-sdk/groq` /
  `@ai-sdk/cerebras` — scripted models answering one line, so routing lands end-to-end in a real
  `Agent` run with no key and no network.
- Three acts: parse splits on the **first** slash (real catalog ids like `openai/gpt-oss-120b`
  are groq-hosted — the id itself contains slashes), route-then-run (the routed model is the
  agent's model), and the catalog as guard (unknown provider / unlisted model / package not
  registered — the error names the npm package to install).

Run it from the repo root, after `pnpm install && pnpm build`:

```
pnpm --filter @oribos/example-model-router start
```
