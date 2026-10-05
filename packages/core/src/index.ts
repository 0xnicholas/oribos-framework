/**
 * `@oribos/core` — composition root.
 *
 * The thin `createApp` assembly point that hands cross-cutting dependencies (tracer, …) to the
 * subsystems attached to it. Subsystems stay fully usable on their own without it (ADR-0002).
 */
export { createApp } from './app.js';
export type { App, AppConfig, AppStorageConfig } from './app.js';
export type { Logger } from './observability/index.js';
