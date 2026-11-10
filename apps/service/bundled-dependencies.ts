/** Protocol/server JS shares the Service's chunks; workspace owners remain external. */
export const serviceBundledDependencies: readonly string[] = Object.freeze([
  '@modelcontextprotocol/sdk',
  'hono',
  'zod',
  'quickjs-emscripten-core',
  '@jitl/quickjs-wasmfile-release-sync',
  '@opentelemetry/otlp-exporter-base',
  '@opentelemetry/otlp-transformer',
  '@opentelemetry/sdk-trace',
  '@opentelemetry/api',
  '@opentelemetry/core',
  '@opentelemetry/resources',
]);
