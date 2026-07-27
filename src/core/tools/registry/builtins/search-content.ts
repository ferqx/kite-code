/**
 * search_content spec — 迁入 Registry（ADR-0043 S1.2）。
 * 契约暂引用 SEARCH_CONTENT_CONTRACT.sections 保持 description 逐字节稳定。
 */
import { z } from 'zod';
import { searchContent } from '@/core/tools/search';
import { SEARCH_CONTENT_CONTRACT } from '@/core/tools/tool-contracts';
import type { ShellResult } from '@/core/types';
import { projectionDigest, truncateProjectedStreams } from '../projection';
import type { ToolSpec } from '../spec';

export interface SearchContentInput {
  pattern: string;
  path?: string;
  glob?: string;
}

export const searchContentSpec: ToolSpec<SearchContentInput, ShellResult> = {
  name: 'search_content',
  kind: 'computer',
  contract: SEARCH_CONTENT_CONTRACT.sections,
  // 与原模型 Schema 逐字节一致（含 describe 文本），不产生 prompt 漂移。
  inputSchema: z.object({
    pattern: z.string().describe('Regex pattern to search for (e.g. "function\\s+\\w+")'),
    path: z
      .string()
      .optional()
      .describe('Directory or file path to search in (default: workspace root)'),
    glob: z.string().optional().describe('File glob filter (e.g. "*.ts", "*.{ts,tsx}")'),
  }),
  declaredEffects: { filesystem: 'read', network: 'none', externalState: 'none' },
  minimumApproval: 'none',
  effects: () => ({
    effectClass: 'read_only',
    sideEffect: false,
    classificationReason: 'search_content is a read-only capability.',
  }),
  approvalSummary: (input) => `search_content ${input.pattern}`,
  execute: (input, context) =>
    searchContent({
      workspace: context.workspace,
      pattern: input.pattern,
      path: input.path ?? '.',
      glob: input.glob,
      allowExternal: context.allowExternalPaths === true,
    }),
  projectResult: (output, context) => {
    // invocationInput 由 Registry dispatch 注入且类型化（i1），无需强转。
    const input = context.invocationInput;
    // 与 shell_execute 一致的逐流投影：execute 产出的两路各自保留并截断。
    // 当前搜索执行器是纯 JS，失败时只填 stderr 一路；投影层保持统一双流
    // 契约，承接未来执行器替换（如外部 rg）可能带来的双路输出。
    // Mirror shell_execute's per-stream projection. The pure-JS executor only
    // populates one stream today; projection keeps the uniform dual-stream
    // contract for future executor replacements.
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
};
