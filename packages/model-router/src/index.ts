/**
 * `@oribos/model-router` — the model-routing capability package: `'provider/model'` strings
 * against a models.dev-style catalog (`docs/architecture/model.md` 篇级字符串路由行,ADR-0017
 * 追赶面中层;#185).
 *
 * The carrying seam is data, not the core: the core's "no registry, no magic string" pins stay
 * untouched (ADR-0004) — this package owns the parse and the catalog, and both are the caller's
 * to bring. `parseModelString` splits a routing string on its first slash (model ids may
 * themselves contain slashes — deepinfra-style ids like `meta-llama/llama-4-scout`); a router
 * built with `createModelRouter` checks the string against a catalog pasted in as-is (a snapshot
 * of `https://models.dev/api.json` satisfies the shape) and hands the model id to the factory
 * you registered for that provider — your installed AI SDK provider package, its dependency
 * staying yours. What the catalog adds over bare parsing is existence: unknown providers and
 * unlisted models are refused at resolution time with actionable errors, including the
 * provider's `npm` package from the catalog when a provider is known but no factory is
 * registered for it.
 *
 * Resolution validates through the core's model contract (`assertModel`) — a factory result that
 * is not a language model instance of the supported specification version surfaces as the core's
 * own contract error, never as a mid-run surprise. Zero cost when unconfigured: the package adds
 * nothing to the core, and a router that is never built never runs.
 *
 * Package face: [`parseModelString`], [`ParsedModelString`], [`InvalidModelStringError`],
 * [`createModelRouter`], [`ModelRouter`], [`ModelRouterConfig`], [`ModelCatalog`],
 * [`CatalogProviderEntry`], [`CatalogModelEntry`], [`ModelProviderFactory`],
 * [`UnknownModelProviderError`], [`UnknownModelError`], [`ModelProviderMissingError`].
 */

import { assertModel } from '@oribos/core/model';
import type { Model } from '@oribos/core/model';

// ── Parse: the routing string ─────────────────────────────────────────────────────────────────

/** A routing string split into its provider and model halves. */
export interface ParsedModelString {
  /** The provider id — everything before the first `/`. */
  readonly providerId: string;
  /** The model id — everything after the first `/`, slashes included. */
  readonly modelId: string;
}

/** `parseModelString` on a value that is not a `'provider/model'` string. */
export class InvalidModelStringError extends Error {
  constructor(value: string) {
    super(
      `not a 'provider/model' string: ${JSON.stringify(value)} — expected '<provider>/<model>', ` +
        "split on the first '/' (the model id may itself contain slashes)",
    );
    this.name = 'InvalidModelStringError';
  }
}

/**
 * Splits a `'provider/model'` routing string on its **first** slash: model ids may themselves
 * contain slashes (deepinfra-style ids like `meta-llama/llama-4-scout`), so only the first
 * segment is the provider. Pure — no catalog, no providers, just the parse.
 */
export function parseModelString(value: string): ParsedModelString {
  const slash = value.indexOf('/');
  const providerId = slash === -1 ? '' : value.slice(0, slash);
  const modelId = slash === -1 ? '' : value.slice(slash + 1);
  if (
    providerId === '' ||
    modelId === '' ||
    providerId.trim() !== providerId ||
    modelId.trim() !== modelId
  ) {
    throw new InvalidModelStringError(value);
  }
  return { providerId, modelId };
}

// ── The catalog: a models.dev-shaped directory, pasted in as data ─────────────────────────────

/** One model's catalog entry. Only the record key is load-bearing; the rest is pasted through. */
export interface CatalogModelEntry {
  /** The model's display name, if the catalog carries one. */
  readonly name?: string | undefined;
  /** The model's window limits, if the catalog carries them. */
  readonly limit?: { readonly context?: number; readonly output?: number } | undefined;
  /** models.dev snapshots carry more fields than routing consumes; they paste through untouched. */
  readonly [key: string]: unknown;
}

/**
 * One provider's catalog entry: which npm package serves it, and which model ids exist under it.
 * A snapshot of `https://models.dev/api.json` satisfies this shape as-is.
 */
export interface CatalogProviderEntry {
  /** The AI SDK provider package that serves this provider — surfaced in missing-factory errors. */
  readonly npm?: string | undefined;
  /** The provider's display name, if the catalog carries one. */
  readonly name?: string | undefined;
  /** The provider's model ids — the existence check routing resolves against. */
  readonly models: Readonly<Record<string, CatalogModelEntry>>;
  /** models.dev snapshots carry more fields than routing consumes; they paste through untouched. */
  readonly [key: string]: unknown;
}

/** The catalog: provider id → provider entry. Data the caller brings (e.g. a models.dev cut). */
export type ModelCatalog = Readonly<Record<string, CatalogProviderEntry>>;

// ── Resolve: catalog + your provider factories → model instances ─────────────────────────────

/**
 * The seam your installed provider package rides: called with the model id exactly as the
 * catalog keys it, returns the language model instance (`(id) => groq(id)` for `@ai-sdk/groq`).
 * The provider package's dependency travels with you, never with this package or the core.
 */
export type ModelProviderFactory = (modelId: string) => unknown;

/** `createModelRouter` config: the catalog (data) and your factories (the installed packages). */
export interface ModelRouterConfig {
  /** Provider id → provider entry; a models.dev snapshot pastes as-is. */
  readonly catalog: ModelCatalog;
  /** Provider id → factory from your installed AI SDK provider package. */
  readonly providers: Readonly<Record<string, ModelProviderFactory>>;
}

/** A router: a routing string in, a contract-validated model instance out. */
export type ModelRouter = (value: string) => Model;

/** Routing a string whose provider id the catalog does not carry. */
export class UnknownModelProviderError extends Error {
  constructor(value: string, catalog: ModelCatalog) {
    super(
      `unknown provider in ${JSON.stringify(value)} — the catalog carries ` +
        `${Object.keys(catalog).length} provider(s); cut a wider catalog (a models.dev snapshot ` +
        'pastes as-is) or fix the provider id',
    );
    this.name = 'UnknownModelProviderError';
  }
}

/** Routing a string whose provider the catalog carries but whose model id it does not list. */
export class UnknownModelError extends Error {
  constructor(value: string, providerId: string, provider: CatalogProviderEntry) {
    super(
      `unknown model in ${JSON.stringify(value)} — the catalog lists ` +
        `${Object.keys(provider.models).length} model(s) for '${providerId}'; cut a wider ` +
        'catalog or fix the model id',
    );
    this.name = 'UnknownModelError';
  }
}

/** Routing a provider the catalog carries but no factory is registered for. */
export class ModelProviderMissingError extends Error {
  constructor(providerId: string, provider: CatalogProviderEntry) {
    const via = typeof provider.npm === 'string' ? ` (the catalog names its package: ${provider.npm})` : '';
    super(
      `no provider factory registered for '${providerId}'${via} — install the provider package ` +
        `and register it: createModelRouter({ catalog, providers: { '${providerId}': (id) => … } })`,
    );
    this.name = 'ModelProviderMissingError';
  }
}

/**
 * Builds a router from a catalog and your installed provider packages: `'groq/llama-3.3-70b'` in,
 * the model instance `groq('llama-3.3-70b')` out — after the catalog has vouched that both the
 * provider and the model id exist. The result is validated through the core's model contract, so
 * a factory that does not return a language model of the supported specification version fails
 * here, at resolution time. Everything — the catalog, the factories — is caller-brought; nothing
 * registers anywhere, and no router exists until you build one.
 */
export function createModelRouter(config: ModelRouterConfig): ModelRouter {
  const { catalog, providers } = config;
  return (value) => {
    const { providerId, modelId } = parseModelString(value);
    const provider = catalog[providerId];
    if (provider === undefined) throw new UnknownModelProviderError(value, catalog);
    if (provider.models[modelId] === undefined) {
      throw new UnknownModelError(value, providerId, provider);
    }
    const factory = providers[providerId];
    if (factory === undefined) throw new ModelProviderMissingError(providerId, provider);
    return assertModel(factory(modelId));
  };
}
