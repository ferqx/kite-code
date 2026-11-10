import { resolve } from 'node:path';
import { buildOtelAdapterAssets } from './assets';

if (import.meta.main)
  await buildOtelAdapterAssets(
    resolve(process.argv[2] ?? 'dist', 'trace-integrations/opentelemetry/runtime'),
  );

export { buildOtelAdapterAssets } from './assets';
