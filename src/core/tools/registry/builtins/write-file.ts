/**
 * write_file spec — 迁入 Registry（ADR-0026 S1.2，含 ADR-0025 §2 append 移除）。
 * 契约暂引用 WRITE_FILE_CONTRACT.sections 保持四个 section 结构；§2 已重写
 * whenToUse（创建或整文件重写，追加由 edit_file 尾部匹配或 shell 表达）。
 */
import { z } from 'zod';
import { type WriteFileResult, writeFile } from '@/core/tools/file';
import { WRITE_FILE_CONTRACT } from '@/core/tools/tool-contracts';
import type { ToolSpec } from '../spec';

export interface WriteFileToolInput {
  path: string;
  content: string;
}

export const writeFileSpec: ToolSpec<WriteFileToolInput, WriteFileResult> = {
  name: 'write_file',
  kind: 'computer',
  contract: WRITE_FILE_CONTRACT.sections,
  // ADR-0025 §2：mode 参数已移除，创建/覆写统一语义。
  inputSchema: z.object({
    path: z.string().describe('Path to the file, relative to workspace'),
    content: z.string().describe('Complete file content to write'),
  }),
  declaredEffects: { filesystem: 'write', network: 'none', externalState: 'none' },
  minimumApproval: 'none',
  effects: () => ({
    effectClass: 'workspace_write',
    sideEffect: true,
    classificationReason: 'write_file creates or overwrites workspace files.',
  }),
  approvalSummary: (input) => `write_file ${input.path}`,
  execute: async (input, context) =>
    writeFile({
      workspace: context.workspace,
      path: input.path,
      content: input.content,
      allowExternal: context.allowExternalPaths === true,
    }),
  // 迁移期 runner 仍组装 diff 展示、截断与 resultMeta（与旧路径字节一致）；
  // projectResult 供未来统一管线消费。
  projectResult: (output) => ({
    ok: output.ok,
    modelContent: output.ok
      ? `Wrote ${output.lines ?? 0} lines to ${output.path}`
      : (output.error ?? ''),
    resultMeta: { workspaceMutationScope: output.path ? [output.path] : [] },
    display: { verb: 'Write', preview: output.path },
  }),
};
