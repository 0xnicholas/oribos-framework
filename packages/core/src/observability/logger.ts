/**
 * The composition root's logger channel (`createApp({ logger })`, ADR-0002): the minimal leveled
 * contract the user satisfies with a logger of their own — `console`, pino and winston all
 * assignable as-is — and the app distributes to the subsystems that take the seam (today the
 * workflow definition: `WorkflowConfig.logger`, exposed on the committed `Workflow.logger`).
 * Logs are not a kernel signal: the kernel writes no log calls of its own, the channel is the one
 * designated path the spec reserves for them, and OTel logs stays cut (observability spec「定位」).
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}
