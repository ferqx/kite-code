import { createHash } from 'node:crypto';
import { build as bundle } from '../../../scripts/tooling/build';
import type { TraceManifest } from './index';

export interface LocalTraceBundle {
  apiVersion: 1;
  source: string;
  sha256: string;
}
/** Build-time only; this leaf is never imported by the guest extension. Host validates the manifest. */
export async function buildTraceBundle(entrypoint: string): Promise<LocalTraceBundle> {
  const result = await bundle({
    entrypoints: [entrypoint],
    target: 'browser',
    format: 'iife',
    packages: 'bundle',
    minify: true,
  });
  if (!result.success) throw new AggregateError(result.logs, 'trace_bundle_build_failed');
  if (result.outputs.length !== 1) throw new Error('trace_bundle_must_be_single_script');
  const source = await result.outputs[0]!.text();
  if (Buffer.byteLength(source) > 512 * 1024) throw new Error('trace_bundle_size_limit');
  return { apiVersion: 1, source, sha256: createHash('sha256').update(source).digest('hex') };
}
export async function packageTraceExtension(
  entrypoint: string,
  manifest: TraceManifest,
): Promise<{ manifest: TraceManifest; bundle: LocalTraceBundle }> {
  return { manifest, bundle: await buildTraceBundle(entrypoint) };
}
