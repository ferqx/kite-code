/**
 * read_file spec — 首个迁入 Registry 的工具（ADR-0043 S1.2）。
 *
 * 契约绑定 READ_FILE_CONTRACT.sections；该兼容命名常量直接引用
 * BUILTIN_TOOL_CONTRACTS 的规范结构化事实。
 */
import { z } from 'zod';
import { readFile } from '@/core/tools/file';
import { READ_FILE_CONTRACT } from '@/core/tools/tool-contracts';
import { projectionDigest } from '../projection';
import { defineExecutableTool } from '../spec';

/** Hard ceiling for the complete model-visible read_file result, marker included. */
export const MAX_MODEL_READ_FILE_CHARS = 64 * 1024;

function safePrefix(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const prefix = value.slice(0, maximum);
  const last = prefix.charCodeAt(prefix.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? prefix.slice(0, -1) : prefix;
}

function continuationMarker(totalLines: number, nextOffset: number): string {
  return `... [read_file truncated; total_lines=${totalLines}; continue with offset=${nextOffset}]`;
}

function clippedLineMarker(totalLines: number, line: number): string {
  return `... [read_file truncated; total_lines=${totalLines}; line ${line} clipped; line offset cannot continue within this line]`;
}

function projectReadFileContent(output: ReadFileOutput): { content: string; truncated: boolean } {
  if (!output.ok) return { content: output.content, truncated: false };

  const fromLine = output.fromLine ?? 1;
  const toLine = output.toLine ?? fromLine;
  const sourceHasMore = toLine < output.totalLines;
  if (!sourceHasMore && output.content.length <= MAX_MODEL_READ_FILE_CHARS) {
    return { content: output.content, truncated: false };
  }

  const lines = output.content.split('\n');
  const kept: string[] = [];
  let keptLength = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const sourceLine = fromLine + index;
    const hasMore = sourceLine < output.totalLines;
    const candidateLength = keptLength + (kept.length > 0 ? 1 : 0) + line.length;
    const projectedLength = hasMore
      ? candidateLength + 1 + continuationMarker(output.totalLines, sourceLine + 1).length
      : candidateLength;
    if (projectedLength > MAX_MODEL_READ_FILE_CHARS) break;
    kept.push(line);
    keptLength = candidateLength;
  }

  if (kept.length > 0) {
    const nextOffset = fromLine + kept.length;
    const marker = continuationMarker(output.totalLines, nextOffset);
    const content = `${kept.join('\n')}\n${marker}`;
    return { content, truncated: true };
  }

  // A single source line can exceed the whole result budget. Existing read_file
  // pagination is line-based, so do not claim that an offset can resume within it.
  const marker = clippedLineMarker(output.totalLines, fromLine);
  const available = Math.max(0, MAX_MODEL_READ_FILE_CHARS - marker.length - 1);
  const prefix = safePrefix(lines[0] ?? '', available);
  return {
    content: prefix ? `${prefix}\n${marker}` : marker,
    truncated: true,
  };
}

export const readFileInputSchema = z.object({
  path: z.string().describe('Path to the file, relative to workspace'),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Starting line number (1-indexed, default 1)'),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Maximum number of lines to read (default 2000)'),
});

export type ReadFileInput = z.infer<typeof readFileInputSchema>;

/** 保留 readFile() 返回字段与 path，供调用方组装既有结果形状（迁移期）。 */
export interface ReadFileOutput {
  ok: boolean;
  content: string;
  error?: string;
  totalLines: number;
  path: string;
  fromLine?: number;
  toLine?: number;
  /** 原始文本（读取状态指纹输入，不作模型输出）。 */
  rawContent?: string;
}

export const readFileSpec = defineExecutableTool({
  name: 'read_file',
  kind: 'computer',
  contract: READ_FILE_CONTRACT.sections,
  inputSchema: readFileInputSchema,
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
      fromLine: result.fromLine,
      toLine: result.toLine,
      rawContent: result.rawContent,
    };
  },
  projectResult: (output) => {
    const projected = projectReadFileContent(output);
    return {
      ok: output.ok,
      modelContent: output.ok
        ? projected.content
        : /(?:not found|no such file|enoent)/iu.test(output.error ?? '')
          ? 'File not found.'
          : 'File could not be read.',
      resultMeta: {
        path: output.path,
        totalLines: output.totalLines,
        truncated: projected.truncated,
        rawResultDigest: projectionDigest(output.content, '', output.ok ? 0 : -1),
      },
    };
  },
  classifyOutcomeV1: (output) =>
    output.ok
      ? {}
      : /(?:not found|no such file|enoent)/iu.test(output.error ?? '')
        ? {
            detailCode: 'tool_reported_failure',
            disposition: 'alternative',
            maximumAdditionalCalls: 1,
            requiresNewModelResponse: true,
            safeAutomaticRetry: false,
            capabilityIntent: 'workspace.search',
          }
        : {
            detailCode: 'tool_reported_failure',
            disposition: 'user_action',
            maximumAdditionalCalls: 0,
            requiresNewModelResponse: true,
            safeAutomaticRetry: false,
          },
});
