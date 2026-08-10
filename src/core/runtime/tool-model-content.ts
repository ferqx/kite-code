/**
 * Sole Runtime-owned public model projection for a completed tool execution.
 * Private command, path, result metadata, classifier advice, and recovery state
 * must remain outside this string.
 */
export function toolExecutionModelContentV1(result: {
  ok: boolean;
  status?: 'success' | 'error' | 'rejected' | 'exhausted';
  stdout?: string;
  stderr?: string;
}): string {
  const succeeded = result.ok && (result.status === undefined || result.status === 'success');
  return succeeded ? result.stdout || result.stderr || '' : result.stderr || result.stdout || '';
}
