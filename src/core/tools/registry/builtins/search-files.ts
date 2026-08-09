/**
 * search_files spec — 迁入 Registry（ADR-0043 S1.2）。
 * 契约暂引用 SEARCH_FILES_CONTRACT.sections 保持 description 逐字节稳定。
 */
import { z } from 'zod';
import { searchFiles } from '@/core/tools/search';
import { SEARCH_FILES_CONTRACT } from '@/core/tools/tool-contracts';
import {
  projectedModelContentDigest,
  projectionDigest,
  truncateProjectedStreams,
} from '../projection';
import { defineExecutableTool } from '../spec';

export const searchFilesInputSchema = z.object({
  pattern: z.string().describe('File name pattern (e.g. "*.test.ts", "config.*")'),
  path: z.string().optional().describe('Directory to search in (default: workspace root)'),
});

export type SearchFilesInput = z.infer<typeof searchFilesInputSchema>;

export const searchFilesSpec = defineExecutableTool({
  name: 'search_files',
  kind: 'computer',
  contract: SEARCH_FILES_CONTRACT.sections,
  inputSchema: searchFilesInputSchema,
  declaredEffects: { filesystem: 'read', network: 'none', externalState: 'none' },
  minimumApproval: 'none',
  governanceRevision: 'protected-path-v1',
  effects: () => ({
    effectClass: 'read_only',
    sideEffect: false,
    classificationReason: 'search_files is a read-only capability.',
  }),
  approvalSummary: (input) => `search_files ${input.pattern}`,
  protectedPathAccesses: (input) => [{ path: input.path ?? '.', operation: 'read' }],
  execute: (input, context) =>
    searchFiles({
      workspace: context.workspace,
      pattern: input.pattern,
      path: input.path ?? '.',
      allowExternal: context.allowExternalPaths === true,
      protectedPathEvaluator: context.protectedPathEvaluator,
    }),
  projectResult: (output, context) => {
    const input = context.invocationInput;
    const streams = truncateProjectedStreams(output.stdout, output.stderr);
    const modelContent = output.ok ? streams.stdout : streams.stderr || streams.stdout;
    return {
      ok: output.ok,
      modelContent,
      streams,
      resultMeta: {
        path: input.path ?? '.',
        matchCount: output.stdout.split('\n').filter(Boolean).length,
        truncated: streams.truncated,
        rawResultDigest: projectionDigest(output.stdout, output.stderr, output.exitCode),
        modelContentDigest: projectedModelContentDigest(modelContent),
        digestScope: streams.truncated ? 'projected' : 'raw',
      },
      display: { verb: 'Find' },
    };
  },
});
