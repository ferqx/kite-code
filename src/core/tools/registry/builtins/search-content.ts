/**
 * search_content spec — 迁入 Registry（ADR-0043 S1.2）。
 * 契约通过兼容命名常量绑定 BUILTIN_TOOL_CONTRACTS 的规范结构化事实。
 */
import { z } from 'zod';
import { searchContent } from '@/core/tools/search';
import { SEARCH_CONTENT_CONTRACT } from '@/core/tools/tool-contracts';
import { projectionDigest, truncateProjectedStreams } from '../projection';
import { defineExecutableTool } from '../spec';

export const searchContentInputSchema = z.object({
  pattern: z.string().describe('Regex pattern to search for (e.g. "function\\s+\\w+")'),
  path: z
    .string()
    .optional()
    .describe('Directory or file path to search in (default: workspace root)'),
  glob: z.string().optional().describe('File glob filter (e.g. "*.ts", "*.{ts,tsx}")'),
});

export type SearchContentInput = z.infer<typeof searchContentInputSchema>;

export const searchContentSpec = defineExecutableTool({
  name: 'search_content',
  kind: 'computer',
  contract: SEARCH_CONTENT_CONTRACT.sections,
  inputSchema: searchContentInputSchema,
  declaredEffects: { filesystem: 'read', network: 'none', externalState: 'none' },
  minimumApproval: 'none',
  governanceRevision: 'protected-path-v1',
  effects: () => ({
    effectClass: 'read_only',
    sideEffect: false,
    classificationReason: 'search_content is a read-only capability.',
  }),
  approvalSummary: (input) => `search_content ${input.pattern}`,
  protectedPathAccesses: (input) => [{ path: input.path ?? '.', operation: 'read' }],
  execute: (input, context) =>
    searchContent({
      workspace: context.workspace,
      pattern: input.pattern,
      path: input.path ?? '.',
      glob: input.glob,
      allowExternal: context.allowExternalPaths === true,
      protectedPathEvaluator: context.protectedPathEvaluator,
    }),
  projectResult: (output, context) => {
    const input = context.invocationInput;
    const streams = truncateProjectedStreams(output.stdout, output.stderr);
    return {
      ok: output.ok,
      modelContent: output.ok ? streams.stdout : streams.stderr || streams.stdout,
      streams,
      resultMeta: {
        path: input.path ?? '.',
        matchCount: output.stdout.split('\n').filter(Boolean).length,
        truncated: streams.truncated,
        rawResultDigest: projectionDigest(output.stdout, output.stderr, output.exitCode),
      },
      display: { verb: 'Search' },
    };
  },
  classifyOutcomeV1: (output) =>
    output.ok
      ? {}
      : {
          detailCode: 'tool_reported_failure',
          disposition: 'correct_args',
          maximumAdditionalCalls: 1,
          requiresNewModelResponse: true,
          safeAutomaticRetry: false,
        },
});
