/**
 * write_file spec — 迁入 Registry（ADR-0043 S1.2，含 ADR-0042 §2 append 移除）。
 * 契约暂引用 WRITE_FILE_CONTRACT.sections 保持四个 section 结构；§2 已重写
 * whenToUse（创建或整文件重写，追加由 edit_file 尾部匹配或 shell 表达）。
 */
import { z } from 'zod';
import { computeLineDiff, formatContentOutput, formatDiffOutput } from '@/core/tools/diff';
import { type WriteFileResult, writeFile } from '@/core/tools/file';
import { WRITE_FILE_CONTRACT } from '@/core/tools/tool-contracts';
import { projectionDigest, truncateProjectedLines } from '../projection';
import type { ToolSpec } from '../spec';

export interface WriteFileToolInput {
  path: string;
  content: string;
}

export const writeFileSpec: ToolSpec<WriteFileToolInput, WriteFileResult> = {
  name: 'write_file',
  kind: 'computer',
  contract: WRITE_FILE_CONTRACT.sections,
  // ADR-0042 §2：mode 参数已移除，创建/覆写统一语义。
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
  projectResult: (output, context) => {
    // invocationInput 由 Registry dispatch 注入且类型化（i1），无需强转。
    const input = context.invocationInput;
    if (!output.ok) {
      return {
        ok: false,
        modelContent: output.error ?? '',
        resultMeta: {
          path: input.path,
          truncated: false,
          workspaceMutationScope: input.path ? [input.path] : [],
        },
        display: { verb: 'Write', preview: input.path },
      };
    }
    let rawContent: string;
    if (context.writeTarget?.existed && context.writeTarget.previousContent !== undefined) {
      const diff = computeLineDiff(context.writeTarget.previousContent, input.content, 1);
      rawContent =
        diff.addedLines === 0 && diff.removedLines === 0
          ? formatContentOutput(
              input.content,
              `Wrote ${output.lines ?? 0} ${output.lines === 1 ? 'line' : 'lines'} to ${input.path} (content unchanged)`,
            )
          : formatDiffOutput(diff);
    } else {
      rawContent = formatContentOutput(
        input.content,
        `Wrote ${output.lines ?? 0} lines to ${input.path}`,
      );
    }
    const projected = truncateProjectedLines(rawContent);
    return {
      ok: true,
      modelContent: projected.content,
      resultMeta: {
        path: input.path,
        truncated: projected.truncated,
        workspaceMutationScope: input.path ? [input.path] : [],
        rawResultDigest: projectionDigest(rawContent, '', 0),
      },
      display: { verb: 'Write', preview: input.path },
    };
  },
};
