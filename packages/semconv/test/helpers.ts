/**
 * Test helpers for the mapping contract suite: the exporter-facing `OTEL_*` environment variables
 * are cleared around each test so a developer's local OTel config can never leak into an
 * assertion (the leaf reads no env today; the guard costs nothing and keeps it that way).
 */

/** The `OTEL_*` environment variables the OTel faces read. */
const OTEL_ENV_VARS = [
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
  'OTEL_EXPORTER_OTLP_TIMEOUT',
  'OTEL_EXPORTER_OTLP_TRACES_TIMEOUT',
  'OTEL_EXPORTER_OTLP_COMPRESSION',
  'OTEL_EXPORTER_OTLP_TRACES_COMPRESSION',
  'OTEL_SERVICE_NAME',
  'OTEL_RESOURCE_ATTRIBUTES',
] as const;

/** Clears every `OTEL_*` variable. */
export function clearOtelEnv(): void {
  for (const name of OTEL_ENV_VARS) delete process.env[name];
}

/** Saves the current `OTEL_*` face; call the returned restore in `afterEach`. */
export function saveOtelEnv(): () => void {
  const saved = Object.fromEntries(
    OTEL_ENV_VARS.map((name) => [name, process.env[name]] as const),
  ) as Record<(typeof OTEL_ENV_VARS)[number], string | undefined>;
  clearOtelEnv();
  return () => {
    clearOtelEnv();
    for (const [name, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[name] = value;
    }
  };
}
