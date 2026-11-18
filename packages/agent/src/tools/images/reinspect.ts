import type { ToolContext, ToolDefinition } from '../../extensions';
import {
  type ImageSourceLocator,
  type readSelectedImageMembers,
  validImageSelection,
} from '../../model-body/selected-image-source';
import { AgentError } from '../../storage/types';
export function createReinspectImagesTool(
  lookup: (
    ctx: ToolContext,
    l: ImageSourceLocator,
    ordinals: number[],
  ) => ReturnType<typeof readSelectedImageMembers>,
  list: (
    ctx: ToolContext,
    beforeSeq?: string,
  ) => Promise<{
    sources: { locator: ImageSourceLocator; sourceCount: number }[];
    nextBeforeSeq: string | null;
  }>,
): ToolDefinition {
  return {
    id: 'files.reinspect_images',
    version: '1',
    model: { name: 'reinspect_images' },
    description:
      'Reinspect selected original image ordinals from a previously authorized view_images result. Use {list:true} to discover recent selected sources. Follow nextBeforeSeq with {list:true,beforeSeq} to scan earlier pages, including after an empty page. Copy the exact locator from image availability; give one to four increasing one-based ordinals. No path lookup or original tool replay. Receipt of this tool result alone does not confirm model delivery.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      oneOf: [{ required: ['locator', 'ordinals'] }, { required: ['list'] }],
      properties: {
        list: { type: 'boolean', const: true },
        beforeSeq: { type: 'string', pattern: '^[1-9][0-9]{0,18}$' },
        locator: {
          type: 'object',
          additionalProperties: false,
          required: ['messageId', 'seq', 'executionId'],
          properties: {
            messageId: { type: 'string', minLength: 1, maxLength: 256 },
            seq: { type: 'string', pattern: '^[1-9][0-9]{0,18}$' },
            executionId: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
        ordinals: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          uniqueItems: true,
          items: { type: 'integer', minimum: 1, maximum: 10 },
        },
      },
    },
    async execute(input, ctx) {
      try {
        if (input && typeof input === 'object' && !Array.isArray(input) && input.list === true) {
          if (
            !ctx.runId ||
            Object.keys(input).some((k) => !['list', 'beforeSeq'].includes(k)) ||
            (input.beforeSeq !== undefined && typeof input.beforeSeq !== 'string')
          )
            throw new AgentError('image_source_unverified');
          return {
            outcome: 'succeeded',
            content: JSON.stringify(await list(ctx, input.beforeSeq)),
          };
        }
        if (
          !input ||
          typeof input !== 'object' ||
          Array.isArray(input) ||
          Object.keys(input).some((k) => !['locator', 'ordinals'].includes(k))
        )
          throw new AgentError('image_source_unverified');
        const { locator, ordinals } = input as unknown as {
          locator: ImageSourceLocator;
          ordinals: number[];
        };
        if (!validImageSelection(locator, ordinals) || !ctx.runId || !ctx.artifacts)
          throw new AgentError('image_source_unverified');
        const result = await lookup(ctx, locator, ordinals);
        ctx.signal.throwIfAborted();
        if (result.kind === 'partial_resource_unavailable')
          return {
            outcome: 'failed',
            content: JSON.stringify({
              kind: result.kind,
              message:
                '选中的受管原图暂缺，本次整组未发图。请在同一授权来源恢复后，重新核对并复看所需序位。',
              source: locator,
              requestedOrdinals: ordinals,
              availableInSelection: result.available,
              missingInSelection: result.missing,
              dispatchedImageBytes: 0,
              deliveryHistory: 'not_checked',
              recovery:
                'Restore the same managed original, then revalidate the same authorized selection. No pixels from this tool execution were provided.',
            }),
          };
        const refs = [];
        for (const [i, content] of result.parts.entries()) {
          ctx.signal.throwIfAborted();
          refs.push(
            await ctx.artifacts.publish({
              key: `source-image-${ordinals[i]}`,
              content,
              mediaType: 'image/png',
            }),
          );
        }
        ctx.signal.throwIfAborted();
        return {
          outcome: 'succeeded',
          content: JSON.stringify({
            kind: 'selected_original_images',
            source: locator,
            ordinals,
            sourceCount: result.count,
            deliveryHistory: 'not_checked',
          }),
          artifactRefs: refs,
          modelImages: refs,
        };
      } catch (error) {
        ctx.signal.throwIfAborted();
        if (!(error instanceof AgentError) || error.code !== 'image_source_unverified') throw error;
        return {
          outcome: 'failed',
          content: JSON.stringify({
            kind: 'image_source_unverified',
            message:
              '当前会话无法核实这次选择或无权访问。请重新列出本会话可见的图片来源；不要猜测其他路径或标识。',
            dispatchedImageBytes: 0,
          }),
        };
      }
    },
  };
}
