/**
 * read_file spec — 首个迁入 Registry 的工具（ADR-0043 S1.2）。
 *
 * 契约文本暂引用 READ_FILE_CONTRACT.sections（迁移期保持 description 逐字节
 * 稳定）；全部工具迁移完成后契约整体移入 spec、tool-contracts.ts 退役。
 */
import { z } from 'zod';
import {
  type ReadFileCursorV2,
  type ReadFileWindowV2Result,
  readFile,
  readFileWindowV2,
} from '@/core/tools/file';
import {
  READ_FILE_RESULT_BUDGET_V2,
  TOOL_RESULT_UTF8_ENVELOPE_MAX_BYTES_V2,
  type ToolResultContinuationReceiptV2,
} from '@/core/tools/result-budget-v2';
import { READ_FILE_CONTRACT } from '@/core/tools/tool-contracts';
import { projectedModelContentDigest, projectionDigest } from '../projection';
import { defineExecutableTool } from '../spec';

export const readFileInputSchemaV1 = z.object({
  path: z.string().describe('Path to the file, relative to workspace'),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Starting line number (1-indexed, default 1)'),
  limit: z.number().int().min(1).optional().describe('Maximum number of lines to read'),
});

const readFileCursorSchemaV2 = z.object({
  lineOffset: z.number().int().min(1),
  utf8ByteOffsetInLine: z.number().int().nonnegative(),
  endLineExclusive: z.number().int().min(1),
  pathDigest: z.string().regex(/^[0-9a-f]{64}$/),
  resourceRevision: z.string().regex(/^[0-9a-f]{64}$/),
  initialOffset: z.number().int().min(1),
  effectiveInitialLimit: z.number().int().min(1),
  windowIdentity: z.string().regex(/^[0-9a-f]{64}$/),
  cursorDigest: z.string().regex(/^[0-9a-f]{64}$/),
});

export const readFileInputSchema = z.union([
  readFileInputSchemaV1.extend({ cursor: z.never().optional() }),
  z.object({
    path: z.string().describe('Path to the file, relative to workspace'),
    cursor: readFileCursorSchemaV2,
    offset: z.never().optional(),
    limit: z.never().optional(),
  }),
]);

export type ReadFileInput = z.infer<typeof readFileInputSchema>;

/** 保留 readFile() 返回字段与 path，供调用方组装既有结果形状（迁移期）。 */
export interface ReadFileOutput {
  ok: boolean;
  content: string;
  error?: string;
  totalLines: number;
  path: string;
  /** 原始文本（读取状态指纹输入，不作模型输出）。 */
  rawContent?: string;
  continuation?: ToolResultContinuationReceiptV2;
}

export const readFileSpec = defineExecutableTool<'read_file', ReadFileInput, ReadFileOutput>({
  name: 'read_file',
  modelResultBudgetV2: READ_FILE_RESULT_BUDGET_V2,
  kind: 'computer',
  contract: READ_FILE_CONTRACT.sections,
  inputSchema: readFileInputSchema,
  modelInputSchema: (context) =>
    context.featureFlags?.toolResultBudgetV2 ? readFileInputSchema : readFileInputSchemaV1,
  declaredEffects: { filesystem: 'read', network: 'none', externalState: 'none' },
  minimumApproval: 'none',
  governanceRevision: 'protected-path-v1',
  effects: () => ({
    effectClass: 'read_only',
    sideEffect: false,
    classificationReason: 'read_file is a read-only capability.',
  }),
  approvalSummary: (input) => `read_file ${input.path}`,
  protectedPathAccesses: (input) => [{ path: input.path, operation: 'read' }],
  execute: async (input, context) => {
    const result = context.featureFlags?.toolResultBudgetV2
      ? readFileWindowV2({
          workspace: context.workspace,
          path: input.path,
          ...('cursor' in input && input.cursor
            ? { cursor: input.cursor as ReadFileCursorV2 }
            : { offset: input.offset, limit: input.limit }),
          maxUtf8Bytes: TOOL_RESULT_UTF8_ENVELOPE_MAX_BYTES_V2,
          allowExternal: context.allowExternalPaths === true,
        })
      : readFile({
          workspace: context.workspace,
          path: input.path,
          offset: input.offset,
          limit: input.limit,
          allowExternal: context.allowExternalPaths === true,
        });
    const continuation = context.featureFlags?.toolResultBudgetV2
      ? (result as ReadFileWindowV2Result).continuation
      : undefined;
    const output: ReadFileOutput = {
      ok: result.ok,
      content: result.content,
      error: result.error,
      totalLines: result.totalLines,
      path: input.path,
      rawContent: result.rawContent,
      ...(continuation ? { continuation } : {}),
    };
    return output;
  },
  projectResult: (output) => {
    const modelContent = output.ok ? (output.content ?? '') : (output.error ?? '');
    return {
      ok: output.ok,
      modelContent,
      resultMeta: {
        path: output.path,
        totalLines: output.totalLines,
        ...(output.rawContent !== undefined
          ? { rawResultDigest: projectionDigest(output.rawContent, '', 0) }
          : {}),
        modelContentDigest: projectedModelContentDigest(modelContent),
        digestScope:
          output.rawContent !== undefined ? ('raw' as const) : ('legacy_unknown' as const),
        ...(output.continuation ? { continuation: output.continuation } : {}),
      },
      display: { verb: 'Read', preview: output.path },
    };
  },
});
