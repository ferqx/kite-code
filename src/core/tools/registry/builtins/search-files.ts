/**
 * search_files spec — 迁入 Registry（ADR-0043 S1.2）。
 * 契约通过兼容命名常量绑定 BUILTIN_TOOL_CONTRACTS 的规范结构化事实。
 */
import { z } from 'zod';
import { SEARCH_FILES_CONTRACT } from '@/core/tools/tool-contracts';
import type { ShellResult } from '@/core/types';
import { projectionDigest, truncateProjectedStreams } from '../projection';
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
  execute: async (input, context): Promise<ShellResult> => {
    const result = await context.workspaceFilesystem?.dispatch({
      kind: 'search_files',
      pattern: input.pattern,
      path: input.path ?? '.',
      pathScope: context.allowExternalPaths === true ? 'approved_external' : 'workspace_only',
    });
    if (!result) {
      return {
        ok: false,
        command: `search_files ${input.pattern}`,
        exitCode: -1,
        stdout: '',
        stderr: 'Workspace filesystem Provider is unavailable.',
      };
    }
    if (!result.ok) {
      return {
        ok: false,
        command: `search_files ${input.pattern}`,
        exitCode: -1,
        stdout: '',
        stderr: result.failure.message,
      };
    }
    if (result.observation.kind !== 'search_files') {
      return {
        ok: false,
        command: `search_files ${input.pattern}`,
        exitCode: -1,
        stdout: '',
        stderr: 'Workspace filesystem Provider returned the wrong observation.',
      };
    }
    const matches = result.observation.matches.filter(
      (path) =>
        !context.protectedPathEvaluator ||
        context.protectedPathEvaluator.evaluate({ path, operation: 'read' }).outcome === 'allow',
    );
    return {
      ok: true,
      command: `search_files ${input.pattern}`,
      exitCode: 0,
      stdout: matches.length > 0 ? `${matches.join('\n')}\n` : '',
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
