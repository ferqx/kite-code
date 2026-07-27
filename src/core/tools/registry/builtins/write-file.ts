import { z } from 'zod';
import { computeLineDiff, formatContentOutput, formatDiffOutput } from '@/core/tools/diff';
import { writeFile } from '@/core/tools/file';
import { WRITE_FILE_CONTRACT } from '@/core/tools/tool-contracts';
import { projectionDigest, truncateProjectedLines } from '../projection';
import { defineExecutableTool } from '../spec';

export const writeFileInputSchema = z.object({
  path: z.string().describe('Path to the file, relative to workspace'),
  content: z.string().describe('Complete file content to write'),
});

export type WriteFileToolInput = z.infer<typeof writeFileInputSchema>;

export const writeFileSpec = defineExecutableTool({
  name: 'write_file',
  kind: 'computer',
  contract: WRITE_FILE_CONTRACT.sections,
  inputSchema: writeFileInputSchema,
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
    const input = context.invocationInput;
    if (!output.ok) {
      return {
        ok: false,
        modelContent: output.error ?? '',
        resultMeta: {
          path: input.path,
          truncated: false,
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
});
