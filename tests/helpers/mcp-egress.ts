import { createHash } from 'node:crypto';
import { type RemoteMcpEgressContentV1, remoteMcpOriginDigestV1 } from '@kite/builtin-runtime/mcp';
import type { DataOriginV1 } from '@kite/runtime-spi';

/** Explicit test provenance; production callers must supply observed State26 lineage. */
export function testRemoteMcpOriginFactsV1(
  content: Readonly<RemoteMcpEgressContentV1>,
): Readonly<{ originDigest: string; sourceOrigins: readonly DataOriginV1[] }> {
  const classification = content.dataClassifications[0] ?? 'public';
  const digest = (domain: string) =>
    `sha256:${createHash('sha256').update(`${domain}\0${classification}`).digest('hex')}`;
  const sourceOrigins: readonly DataOriginV1[] = Object.freeze([
    Object.freeze({
      originId: digest('kite.test.mcp-origin.v1'),
      kind: 'user' as const,
      classification,
      ownerProjectId: 'project_test_runtime_agent',
      parentOriginIds: Object.freeze([]),
      observationId: digest('kite.test.mcp-observation.v1'),
    }),
  ]);
  return Object.freeze({
    sourceOrigins,
    originDigest: remoteMcpOriginDigestV1(sourceOrigins),
  });
}
