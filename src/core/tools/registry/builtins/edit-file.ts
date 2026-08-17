/**
 * edit_file spec — 迁入 Registry（ADR-0043 S1.2，含 §3 严格精确匹配）。
 * 契约暂引用 EDIT_FILE_CONTRACT.sections；failureHandling 已按严格语义重写
 * （匹配失败即失败，引导重读；match_mode 已在阶段 0 从模型表面删除，
 * matchMode='trimmed' 仅为内部 opt-in）。
 */
import { z } from 'zod';
import { computeLineDiff, formatDiffOutput, formatMultiHunkDiff } from '@/core/tools/diff';
import { EDIT_FILE_CONTRACT } from '@/core/tools/tool-contracts';
import { projectionDigest, truncateProjectedLines } from '../projection';
import { defineExecutableTool } from '../spec';

export const editFileInputSchema = z.object({
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
});

export type EditFileToolInput = z.infer<typeof editFileInputSchema>;

export const editFileSpec = defineExecutableTool({
  name: 'edit_file',
  kind: 'computer',
  contract: EDIT_FILE_CONTRACT.sections,
  inputSchema: editFileInputSchema,
  declaredEffects: { filesystem: 'write', network: 'none', externalState: 'none' },
  minimumApproval: 'none',
  governanceRevision: 'protected-path-v1',
  effects: () => ({
    effectClass: 'workspace_write',
    sideEffect: true,
    classificationReason: 'edit_file modifies workspace files.',
  }),
  approvalSummary: (input) => `edit_file ${input.path}`,
  protectedPathAccesses: (input) => [
    { path: input.path, operation: 'read' },
    { path: input.path, operation: 'write' },
  ],
  execute: async (input, context) => {
    const result = await context.workspaceFilesystem?.dispatch({
      kind: 'edit_file',
      path: input.path,
      pathScope: context.allowExternalPaths === true ? 'approved_external' : 'workspace_only',
      oldString: input.old_string,
      newString: input.new_string,
      replaceAll: input.replace_all,
    });
    if (!result) return { ok: false, error: 'Workspace filesystem Provider is unavailable.' };
    if (!result.ok) {
      const message =
        result.failure.code === 'read_required'
          ? `File has not been read yet: ${input.path}. Read it with read_file first, then retry edit_file.`
          : result.failure.code === 'stale_read'
            ? `File has been modified since you last read it: ${input.path}. Re-read it with read_file, then retry with the exact current content.`
            : result.failure.message;
      return { ok: false, error: message };
    }
    if (result.observation.kind !== 'committed_mutation') {
      return { ok: false, error: 'Workspace filesystem Provider returned the wrong observation.' };
    }
    return {
      ok: true,
      content: result.observation.content,
      fromLine: result.observation.fromLine,
      toLine: result.observation.toLine,
      replacements: result.observation.replacements,
      matchLines: result.observation.matchLines,
      filesystemObservation: result.filesystemObservation,
    };
  },
  projectResult: (output, context) => {
    const input = context.invocationInput;
    if (!output.ok) {
      return {
        ok: false,
        modelContent: output.error ?? '',
        resultMeta: {
          path: input.path,
          truncated: false,
        },
      };
    }
    const parts: string[] = [];
    if (input.replace_all && output.matchLines && output.matchLines.length > 1) {
      parts.push(
        formatMultiHunkDiff(
          input.old_string,
          input.new_string,
          [...output.matchLines],
          output.replacements ?? 1,
        ),
      );
    } else {
      if (input.replace_all) {
        const count = output.replacements ?? 1;
        parts.push(`(replaced ${count} time${count > 1 ? 's' : ''})`);
      }
      parts.push(
        formatDiffOutput(computeLineDiff(input.old_string, input.new_string, output.fromLine ?? 1)),
      );
    }
    if (input.old_string === input.new_string) parts.push('(no effective change)');
    const rawContent = parts.join('\n');
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
    };
  },
});
