/**
 * Oribos model-router example — `'provider/model'` strings routed to model instances against a
 * catalog snapshot.
 *
 * One script, no external services: the catalog is a committed cut of the models.dev directory
 * (`catalog.json`, providers `groq` + `cerebras`, fields trimmed to what routing reads — the
 * shape is api.json's, a wider cut pastes as-is), and the "provider packages" are teaching stubs
 * standing in for `@ai-sdk/groq` / `@ai-sdk/cerebras` — scripted models that answer one line. No
 * API key, no network; routing is construction, and the one agent run is scripted.
 *
 * The seam is data: the core keeps no registry and no magic strings (ADR-0004) — `parseModelString`
 * and `createModelRouter` live entirely in `@oribos/model-router`, and both the catalog and the
 * factories are the application's to bring.
 *
 * The acts:
 *
 * 1. **Parse splits on the first slash only.** The catalog carries real ids that themselves
 *    contain slashes (`openai/gpt-oss-120b` is a *groq-hosted* model): routing
 *    `'groq/openai/gpt-oss-120b'` means provider `groq`, model `openai/gpt-oss-120b`.
 * 2. **Route, then run.** `'groq/llama-3.3-70b-versatile'` resolves through the registered
 *    factory to a contract-validated model, which goes straight into `new Agent({ model })` and
 *    answers one scripted line — the routed model is the agent's model.
 * 3. **The catalog is the guard.** Three refusals, each actionable: a provider this cut doesn't
 *    carry, a model the provider doesn't list, and a provider whose package isn't registered —
 *    the error names the package to install.
 *
 * The script self-asserts (`node:assert/strict`); any wrong route, missing guard, or unscripted
 * model call exits 1.
 *
 * Run it (from the repo root, after `pnpm install && pnpm build`):
 *
 *   pnpm --filter @oribos/example-model-router start
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Agent } from '@oribos/core/agent';
import type { Model, ModelStreamPart } from '@oribos/core/model';
import { createModelRouter, parseModelString } from '@oribos/model-router';
import type { ModelCatalog, ModelProviderFactory } from '@oribos/model-router';

// ── The catalog: a committed snapshot cut of https://models.dev/api.json ──────────────────────

/** The snapshot: providers `groq` + `cerebras`, per-model fields trimmed, shape unchanged. */
const catalog = JSON.parse(
  readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'),
) as ModelCatalog;

// ── Teaching stubs: the "installed provider packages", scripted ──────────────────────────────

/** A minimal scripted `Model` (the vendor contract) — routing hands this to the agent. */
function scriptedModel(provider: string, modelId: string, line: string): Model {
  return {
    specificationVersion: 'v4',
    provider,
    modelId,
    doGenerate: async () => {
      throw new Error('the example only streams');
    },
    doStream: async () => ({
      stream: new ReadableStream<ModelStreamPart>({
        start(controller) {
          const parts: ModelStreamPart[] = [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text-0' },
            { type: 'text-delta', id: 'text-0', delta: line },
            { type: 'text-end', id: 'text-0' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: { total: 24, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 12, text: undefined, reasoning: undefined },
              },
            },
          ];
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      }),
    }),
  };
}

/** Stand-ins for the installed packages: `(id) => groq(id)` in a real deployment. */
const providers: Readonly<Record<string, ModelProviderFactory>> = {
  groq: (id) => scriptedModel('groq', id, `routed through the catalog: ${id}`),
  cerebras: (id) => scriptedModel('cerebras', id, `routed through the catalog: ${id}`),
};

console.log('model-router — strings in, contract-validated model instances out.');
console.log(
  `catalog snapshot: ${Object.keys(catalog).length} providers, ` +
    `${Object.values(catalog).reduce((sum, p) => sum + Object.keys(p.models).length, 0)} models ` +
    '(a cut of models.dev/api.json; a wider cut pastes as-is).',
);

// ── Act 1 — parse: the first slash is the provider, the rest is the model id ──────────────────

console.log('\n──────── Act 1 — parse splits on the first slash only ────────');
{
  // A real catalog case: gpt-oss-120b hosted on groq — its id itself contains slashes.
  const parsed = parseModelString('groq/openai/gpt-oss-120b');
  assert.equal(parsed.providerId, 'groq');
  assert.equal(parsed.modelId, 'openai/gpt-oss-120b');
  assert.ok(catalog.groq?.models[parsed.modelId] !== undefined, 'the parsed model id is a real catalog key');
  console.log(`'groq/openai/gpt-oss-120b' → provider '${parsed.providerId}', model '${parsed.modelId}'`);

  assert.throws(() => parseModelString('gpt-oss-120b'), /not a 'provider\/model' string/);
  console.log("'gpt-oss-120b' (no slash) refused — the core never grew a magic string; this parse is the package's.");
}

// ── Act 2 — route, then run: the routed model is the agent's model ────────────────────────────

console.log('\n──────── Act 2 — route a string, run the agent on it ────────');
{
  const route = createModelRouter({ catalog, providers });

  const model = route('groq/llama-3.3-70b-versatile');
  assert.equal(model.provider, 'groq');
  assert.equal(model.modelId, 'llama-3.3-70b-versatile');
  assert.equal(model.specificationVersion, 'v4');

  const agent = new Agent({
    name: 'router-demo',
    instructions: 'You are concise.',
    model, // the routed model, contract-validated at resolution time
  });
  const output = await agent.generate('say the line');
  assert.equal(output.text, 'routed through the catalog: llama-3.3-70b-versatile');

  const entry = catalog.groq?.models['llama-3.3-70b-versatile'];
  console.log(`'groq/llama-3.3-70b-versatile' → ${model.provider}/${model.modelId} (spec ${model.specificationVersion})`);
  console.log(`  catalog says: ${entry?.name ?? '?'} · ${entry?.limit?.context ?? '?'} ctx · tool_call=${String(entry?.tool_call)}`);
  console.log(`  the agent answered: ${JSON.stringify(output.text)}`);
}

// ── Act 3 — the catalog is the guard: three actionable refusals ───────────────────────────────

console.log('\n──────── Act 3 — the catalog refuses what it cannot vouch for ────────');
{
  const route = createModelRouter({ catalog, providers });

  /** Runs a call that must refuse; returns the error so its message can be shown. */
  const refuse = (call: () => unknown): Error => {
    try {
      call();
    } catch (error) {
      assert.ok(error instanceof Error);
      return error;
    }
    throw new Error('expected a refusal, got a model');
  };

  // A provider this cut doesn't carry (cut a wider snapshot, or fix the id).
  const unknownProvider = refuse(() => route('anthropic/claude-fable-5'));
  assert.match(unknownProvider.name, /UnknownModelProviderError/);
  console.log(`'anthropic/claude-fable-5' → ${unknownProvider.message.split(' — ')[0]}`);

  // A model the provider doesn't list.
  const unknownModel = refuse(() => route('groq/not-a-model'));
  assert.match(unknownModel.name, /UnknownModelError/);
  console.log(`'groq/not-a-model' → ${unknownModel.message.split(' — ')[0]}`);

  // A provider whose package isn't registered — the error names the package to install.
  const groqOnly = createModelRouter({ catalog, providers: { groq: providers.groq! } });
  const missing = refuse(() => groqOnly('cerebras/gpt-oss-120b'));
  assert.match(missing.name, /ModelProviderMissingError/);
  assert.match(missing.message, /@ai-sdk\/cerebras/);
  console.log(`'cerebras/gpt-oss-120b' with no cerebras factory → ${missing.message.split(' — ')[0]}`);
}

console.log('\nDone — one parse, one catalog, your provider packages; the core kept no registry.');
