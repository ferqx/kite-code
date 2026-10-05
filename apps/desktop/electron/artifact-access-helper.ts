import { acquireInheritedArtifactAccess } from '@kite-ai/agent/artifact-access';

try {
  if (process.argv.length !== 3) throw Error('artifact_access_unavailable');
  const input: unknown = JSON.parse(process.argv[2]!);
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).join(',') !== 'root' ||
    !('root' in input) ||
    typeof input.root !== 'string'
  )
    throw Error('artifact_access_unavailable');
  const lease = acquireInheritedArtifactAccess({ root: input.root, fd: 3 });
  lease.release();
  console.log('artifact-access-acquired');
} catch {
  console.log('artifact_access_unavailable');
  process.exitCode = 1;
}
