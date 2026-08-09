/**
 * edit_file spec — 迁入 Registry（ADR-0043 S1.2，含 §3 严格精确匹配）。
 * 契约暂引用 EDIT_FILE_CONTRACT.sections；failureHandling 已按严格语义重写
 * （匹配失败即失败，引导重读；match_mode 已在阶段 0 从模型表面删除，
 * matchMode='trimmed' 仅为内部 opt-in）。
 */
import { z } from 'zod';
import { computeLineDiff, formatDiffOutput, formatMultiHunkDiff } from '@/core/tools/diff';
import { editFile } from '@/core/tools/file';
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
  availability: (context) =>
    !(context.featureFlags?.promptContractV2 && context.phase === 'planning'),
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
  preExecute: (input, context) => {
    const target = context.writeTarget;
    if (!target) {
      return {
        proceed: false,
        rejection: {
          ok: false,
          error: `Missing verified read state for: ${input.path}`,
          guidance: 'Read the exact target file before editing it.',
        },
      };
    }
    if (target.path !== input.path) {
      return {
        proceed: false,
        rejection: {
          ok: false,
          error: `Read state path "${target.path}" does not match edit target "${input.path}".`,
          guidance: 'Read the exact target file before editing it.',
        },
      };
    }
    if (target.readState !== 'fresh') {
      if (target.readState === 'not_read') {
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
      return {
        proceed: false,
        rejection: {
          ok: false,
          error:
            target.readState === 'stale'
              ? `File has been modified since you last read it: ${input.path}. Re-read it with read_file, then retry with the exact current content.`
              : `Missing or invalid read state for: ${input.path}. Read the exact target file before editing it.`,
          guidance:
            target.readState === 'stale'
              ? 'The recorded content fingerprint no longer matches the file on disk.'
              : 'Read the exact target file before editing it.',
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
        display: { verb: 'Update', preview: input.path },
      };
    }
    const parts: string[] = [];
    if (input.replace_all && output.matchLines && output.matchLines.length > 1) {
      parts.push(
        formatMultiHunkDiff(
          input.old_string,
          input.new_string,
          output.matchLines,
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
      display: { verb: 'Update', preview: input.path },
    };
  },
});
