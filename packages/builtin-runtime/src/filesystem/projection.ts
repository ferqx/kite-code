import { createHash } from 'node:crypto';

export function projectionDigest(stdout: string, stderr: string, exitCode: number): string {
  return createHash('sha256').update(JSON.stringify({ stdout, stderr, exitCode })).digest('hex');
}

export function truncateProjectedLines(
  content: string,
  limit = 2000,
): { content: string; truncated: boolean } {
  if (content.length <= limit) return { content, truncated: false };
  const totalLines = content.split('\n').length;
  const cut = content.lastIndexOf('\n', limit);
  const kept = content.slice(0, cut > 0 ? cut : limit);
  const omitted = totalLines - kept.split('\n').length;
  return {
    content: `${kept}\n... (${omitted} more line${omitted !== 1 ? 's' : ''} omitted)`,
    truncated: true,
  };
}

export function truncateProjectedOutput(output: string, maxLen = 4000): string {
  if (output.length <= maxLen) return output;
  const keep = Math.floor(maxLen / 2);
  const head = output.slice(0, keep);
  const tail = output.slice(-keep);
  const omittedLines = output.slice(keep, -keep).split('\n').filter(Boolean).length;
  return `${head}\n... [${omittedLines} lines omitted, ${output.length - 2 * keep} total chars truncated]\n${tail}`;
}

export function truncateProjectedStreams(
  stdout: string,
  stderr: string,
  maxLen = 4000,
): { stdout: string; stderr: string; truncated: boolean } {
  const projectedStdout = truncateProjectedOutput(stdout, maxLen);
  const projectedStderr = truncateProjectedOutput(stderr, maxLen);
  return {
    stdout: projectedStdout,
    stderr: projectedStderr,
    truncated: projectedStdout !== stdout || projectedStderr !== stderr,
  };
}
