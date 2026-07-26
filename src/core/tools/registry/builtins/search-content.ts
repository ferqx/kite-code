/**
 * search_content spec — 迁入 Registry（ADR-0043 S1.2）。
 * 契约暂引用 SEARCH_CONTENT_CONTRACT.sections 保持 description 逐字节稳定。
 */
import { z } from 'zod';
import { searchContent } from '@/core/tools/search';
import { SEARCH_CONTENT_CONTRACT } from '@/core/tools/tool-contracts';
import type { ShellResult } from '@/core/types';
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
  // 迁移期 runner 仍组装截断与 resultMeta（与旧路径字节一致）；
  // projectResult 供未来统一管线消费。
  projectResult: (output) => ({
    ok: output.ok,
    modelContent: output.stdout,
    resultMeta: {},
    display: { verb: 'Search' },
  }),
};
