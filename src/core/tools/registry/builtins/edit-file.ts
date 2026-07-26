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
