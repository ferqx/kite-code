/**
 * edit_file spec — 迁入 Registry（ADR-0026 S1.2，含 §3 严格精确匹配）。
 * 契约暂引用 EDIT_FILE_CONTRACT.sections；failureHandling 已按严格语义重写
 * （匹配失败即失败，引导重读；match_mode 已在阶段 0 从模型表面删除，
 * matchMode='trimmed' 仅为内部 opt-in）。
 */
import { z } from 'zod';
import { type EditFileResult, editFile } from '@/core/tools/file';
import { EDIT_FILE_CONTRACT } from '@/core/tools/tool-contracts';
import type { ToolSpec } from '../spec';

export interface EditFileToolInput {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export const editFileSpec: ToolSpec<EditFileToolInput, EditFileResult> = {
  name: 'edit_file',
  kind: 'computer',
  contract: EDIT_FILE_CONTRACT.sections,
  inputSchema: z.object({
    path: z.string().describe('Path to the file to edit, relative to workspace'),
    old_string: z
      .string()
      .describe(
        'The exact text to replace. Must match the file content exactly, including whitespace.',
      ),
    new_string: z.string().describe('The new text to replace old_string with'),
    replace_all: z
      .boolean()
      .optional()
      .describe('Replace all occurrences (default: false, fails if multiple matches found)'),
  }),
  declaredEffects: { filesystem: 'write', network: 'none', externalState: 'none' },
  minimumApproval: 'none',
  effects: () => ({
    effectClass: 'workspace_write',
    sideEffect: true,
    classificationReason: 'edit_file modifies workspace files.',
  }),
  approvalSummary: (input) => `edit_file ${input.path}`,
  // ADR-0025 §1：先读后改 + 过期拒绝。读取状态由调用方（tool-runner）
  // 基于会话指纹跟踪注入；对齐 Claude Code 的两条工具层硬失败。
  preExecute: (input, context) => {
    const readState = context.writeTarget?.readState;
    if (readState === 'not_read') {
      return {
        proceed: false,
        rejection: {
          ok: false,
          error: `File has not been read yet: ${input.path}. Read it with read_file first, then retry edit_file.`,
          guidance:
            'edit_file requires the target to have been read in this session so old_string comes from verified content.',
        },
      };
    }
    if (readState === 'stale') {
      return {
        proceed: false,
        rejection: {
          ok: false,
          error: `File has been modified since you last read it: ${input.path}. Re-read it with read_file, then retry with the exact current content.`,
          guidance: 'The recorded content fingerprint no longer matches the file on disk.',
        },
      };
    }
    return { proceed: true };
  },
  execute: async (input, context) =>
    editFile({
      workspace: context.workspace,
      path: input.path,
      oldString: input.old_string,
      newString: input.new_string,
      replaceAll: input.replace_all,
      allowExternal: context.allowExternalPaths === true,
    }),
  // 迁移期 runner 仍组装 diff 展示、截断与 resultMeta（与旧路径字节一致）；
  // projectResult 供未来统一管线消费。
  projectResult: (output) => ({
    ok: output.ok,
    modelContent: output.ok
      ? `Replaced ${output.replacements ?? 1} occurrence(s) in ${output.path}`
      : (output.error ?? ''),
    resultMeta: { workspaceMutationScope: output.path ? [output.path] : [] },
    display: { verb: 'Update', preview: output.path },
  }),
};
