import { createHash } from 'node:crypto';

/** Sole model-visible text projection for a completed Builtin Tool execution. */
export function toolExecutionModelContentV1(result: {
  readonly ok: boolean;
  readonly status?: 'success' | 'error' | 'rejected' | 'exhausted';
  readonly stdout?: string;
  readonly stderr?: string;
}): string {
  const succeeded = result.ok && (result.status === undefined || result.status === 'success');
  return succeeded ? result.stdout || result.stderr || '' : result.stderr || result.stdout || '';
}

export interface BuiltinToolResultDigestProjectionV1 {
  readonly contentDigest: string;
  readonly rawResultDigest?: string;
  readonly modelContentDigest: string;
  readonly digestScope: 'raw' | 'projected';
}

/**
 * Project the stable State digest metadata for a completed Builtin Tool
 * result. This preserves the accepted pre-cutover result envelope while
 * keeping model-content semantics in Builtin Runtime.
 */
export function projectBuiltinToolResultDigestsV1(input: {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly status?: 'success' | 'error' | 'rejected' | 'exhausted';
  readonly rawResultDigest?: string;
  readonly truncated?: boolean;
}): Readonly<BuiltinToolResultDigestProjectionV1> {
  const modelContentDigest = createHash('sha256')
    .update(toolExecutionModelContentV1(input))
    .digest('hex');
  const completeResultDigest = createHash('sha256')
    .update(
      JSON.stringify({
        stdout: input.stdout,
        stderr: input.stderr,
        exitCode: input.exitCode,
        status: input.status,
      }),
    )
    .digest('hex');
  const rawResultDigest =
    input.rawResultDigest ?? (input.truncated ? undefined : completeResultDigest);
  return Object.freeze({
    contentDigest: modelContentDigest,
    ...(rawResultDigest ? { rawResultDigest } : {}),
    modelContentDigest,
    digestScope: input.truncated ? ('projected' as const) : ('raw' as const),
  });
}
