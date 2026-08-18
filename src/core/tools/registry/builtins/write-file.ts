import { z } from 'zod';
import { computeLineDiff, formatContentOutput, formatDiffOutput } from '@/core/tools/diff';
import { WRITE_FILE_CONTRACT } from '@/core/tools/tool-contracts';
import { projectionDigest, truncateProjectedLines } from '../projection';
import { defineExecutableTool } from '../spec';

export const writeFileInputSchema = z.object({
  path: z
    .string()
    .describe('Workspace-relative path, or an approved absolute/home-relative external path'),
  content: z.string().describe('Complete file content to write'),
});

export type WriteFileToolInput = z.infer<typeof writeFileInputSchema>;

interface WriteFileProviderOutput {
  ok: boolean;
  error?: string;
  path?: string;
  lines?: number;
  content?: string;
  previousContent?: string;
  previouslyExisted?: boolean;
  filesystemObservation?: import('@/protocol/capabilities').WorkspaceFilesystemObservationRecordV1;
}

export const writeFileSpec = defineExecutableTool({
  name: 'write_file',
  kind: 'computer',
  contract: WRITE_FILE_CONTRACT.sections,
  inputSchema: writeFileInputSchema,
  declaredEffects: { filesystem: 'write', network: 'none', externalState: 'none' },
  minimumApproval: 'none',
  governanceRevision: 'trusted-workspace-file-access-v1',
  effects: () => ({
    effectClass: 'workspace_write',
    sideEffect: true,
    classificationReason: 'write_file creates or overwrites workspace files.',
  }),
  approvalSummary: (input) => `write_file ${input.path}`,
  protectedPathAccesses: (input) => [
    { path: input.path, operation: 'read' },
    { path: input.path, operation: 'write' },
  ],
  execute: async (input, context): Promise<WriteFileProviderOutput> => {
    const result = await context.workspaceFilesystem?.dispatch({
      kind: 'write_file',
      path: input.path,
      pathScope: context.allowExternalPaths === true ? 'approved_external' : 'workspace_only',
      content: input.content,
    });
    if (!result) return { ok: false, error: 'Workspace filesystem Provider is unavailable.' };
    if (!result.ok) return { ok: false, error: result.failure.message };
    if (result.observation.kind !== 'committed_mutation') {
      return { ok: false, error: 'Workspace filesystem Provider returned the wrong observation.' };
    }
    return {
      ok: true,
      lines: result.observation.lines,
      content: result.observation.content,
      previousContent: result.preimage?.content ?? undefined,
      previouslyExisted: result.preimage?.existed ?? false,
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
    let rawContent: string;
    if (output.previouslyExisted && output.previousContent !== undefined) {
      const diff = computeLineDiff(output.previousContent, input.content, 1);
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
    };
  },
});
