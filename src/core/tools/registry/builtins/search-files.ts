/**
 * search_files spec — 迁入 Registry（ADR-0043 S1.2）。
 * 契约暂引用 SEARCH_FILES_CONTRACT.sections 保持 description 逐字节稳定。
 */
import { z } from 'zod';
import { searchFiles } from '@/core/tools/search';
import { SEARCH_FILES_CONTRACT } from '@/core/tools/tool-contracts';
import type { ShellResult } from '@/core/types';
import type { ToolSpec } from '../spec';

export interface SearchFilesInput {
  pattern: string;
  path?: string;
}

export const searchFilesSpec: ToolSpec<SearchFilesInput, ShellResult> = {
  name: 'search_files',
  kind: 'computer',
  contract: SEARCH_FILES_CONTRACT.sections,
  // 与原模型 Schema 逐字节一致（含 describe 文本），不产生 prompt 漂移。
  inputSchema: z.object({
    pattern: z.string().describe('File name pattern (e.g. "*.test.ts", "config.*")'),
    path: z.string().optional().describe('Directory to search in (default: workspace root)'),
  }),
  declaredEffects: { filesystem: 'read', network: 'none', externalState: 'none' },
  minimumApproval: 'none',
  effects: () => ({
    effectClass: 'read_only',
    sideEffect: false,
    classificationReason: 'search_files is a read-only capability.',
  }),
  approvalSummary: (input) => `search_files ${input.pattern}`,
  execute: (input, context) =>
    searchFiles({
      workspace: context.workspace,
      pattern: input.pattern,
      path: input.path ?? '.',
      allowExternal: context.allowExternalPaths === true,
    }),
  // 迁移期 runner 仍组装截断与 resultMeta（与旧路径字节一致）；
  // projectResult 供未来统一管线消费。
  projectResult: (output) => ({
    ok: output.ok,
    modelContent: output.stdout,
    resultMeta: {},
    display: { verb: 'Find' },
  }),
};
