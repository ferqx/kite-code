/**
 * read_file spec — 首个迁入 Registry 的工具（ADR-0043 S1.2）。
 *
 * 契约文本暂引用 READ_FILE_CONTRACT.sections（迁移期保持 description 逐字节
 * 稳定）；全部工具迁移完成后契约整体移入 spec、tool-contracts.ts 退役。
 */
import { z } from 'zod';
import { readFile } from '@/core/tools/file';
import { READ_FILE_CONTRACT } from '@/core/tools/tool-contracts';
import type { ToolSpec } from '../spec';

export interface ReadFileInput {
  path: string;
  offset?: number;
  limit?: number;
}

/** 保留 readFile() 返回字段与 path，供调用方组装既有结果形状（迁移期）。 */
export interface ReadFileOutput {
  ok: boolean;
  content: string;
  error?: string;
  totalLines: number;
  path: string;
  /** 原始文本（读取状态指纹输入，不作模型输出）。 */
  rawContent?: string;
}

export const readFileSpec: ToolSpec<ReadFileInput, ReadFileOutput> = {
  name: 'read_file',
  kind: 'computer',
  contract: READ_FILE_CONTRACT.sections,
  // 与原模型 Schema 逐字节一致（含 describe 文本），不产生 prompt 漂移。
  inputSchema: z.object({
    path: z.string().describe('Path to the file, relative to workspace'),
    offset: z.number().optional().describe('Starting line number (1-indexed, default 1)'),
    limit: z.number().optional().describe('Maximum number of lines to read'),
  }),
  declaredEffects: { filesystem: 'read', network: 'none', externalState: 'none' },
  minimumApproval: 'none',
  effects: () => ({
    effectClass: 'read_only',
    sideEffect: false,
    classificationReason: 'read_file is a read-only capability.',
  }),
  approvalSummary: (input) => `read_file ${input.path}`,
  execute: async (input, context) => {
    const result = readFile({
      workspace: context.workspace,
      path: input.path,
      offset: input.offset,
      limit: input.limit,
      allowExternal: context.allowExternalPaths === true,
    });
    return {
      ok: result.ok,
      content: result.content,
      error: result.error,
      totalLines: result.totalLines,
      path: input.path,
      rawContent: result.rawContent,
    };
  },
  projectResult: (output) => ({
    ok: output.ok,
    modelContent: output.ok ? (output.content ?? '') : (output.error ?? ''),
    resultMeta: { path: output.path, totalLines: output.totalLines },
    display: { verb: 'Read', preview: output.path },
  }),
};
