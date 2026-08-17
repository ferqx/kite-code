/**
 * search_content spec — 迁入 Registry（ADR-0043 S1.2）。
 * 契约通过兼容命名常量绑定 BUILTIN_TOOL_CONTRACTS 的规范结构化事实。
 */
import { z } from 'zod';
import { SEARCH_CONTENT_CONTRACT } from '@/core/tools/tool-contracts';
import type { ShellResult } from '@/core/types';
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
  execute: async (input, context): Promise<ShellResult> => {
    const result = await context.workspaceFilesystem?.dispatch({
      kind: 'search_content',
      pattern: input.pattern,
      path: input.path ?? '.',
      glob: input.glob,
      pathScope: context.allowExternalPaths === true ? 'approved_external' : 'workspace_only',
    });
    if (!result) {
      return {
        ok: false,
        command: `search_content ${input.pattern}`,
        exitCode: -1,
        stdout: '',
        stderr: 'Workspace filesystem Provider is unavailable.',
      };
    }
    if (!result.ok) {
      return {
        ok: false,
        command: `search_content ${input.pattern}`,
        exitCode: -1,
        stdout: '',
        stderr: result.failure.message,
      };
    }
    if (result.observation.kind !== 'search_content') {
      return {
        ok: false,
        command: `search_content ${input.pattern}`,
        exitCode: -1,
        stdout: '',
        stderr: 'Workspace filesystem Provider returned the wrong observation.',
      };
    }
    const lines = result.observation.matches
      .filter(
        (match) =>
          !context.protectedPathEvaluator ||
          context.protectedPathEvaluator.evaluate({ path: match.path, operation: 'read' })
            .outcome === 'allow',
      )
      .map((match) => `${match.path}:${match.line}:${match.text}`);
    return {
      ok: true,
      command: `search_content ${input.pattern}`,
      exitCode: 0,
      stdout: lines.length > 0 ? `${lines.join('\n')}\n` : '',
      stderr: '',
    };
  },
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
