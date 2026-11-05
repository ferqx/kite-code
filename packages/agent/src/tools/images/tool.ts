import { createHash } from 'node:crypto';
import type { ArtifactRef, ToolContext, ToolDefinition } from '../../extensions';
import { AgentError, type Json } from '../../storage/types';
import { imageBatchBytes, imageBatchCount, imageInputBytes } from './format';
import { imagePaths } from './input';
import { ImageProcessCleanupError, processImage } from './processor';

export interface ImageSource {
  path: string;
  bytes: Uint8Array;
  hash?: string;
}
type ImageReader = (
  path: string,
  context: ToolContext,
  signal: AbortSignal,
) => Promise<ImageSource>;
export function createViewImagesTool(
  source:
    | ImageReader
    | { prepare(paths: readonly string[], context: ToolContext): Promise<ImageReader> },
): ToolDefinition {
  return {
    id: 'files.view_images',
    version: '1',
    model: { name: 'view_images' },
    description:
      'View 1 to 10 local PNG, JPEG, WebP or GIF images as actual model visual input. Use paths for an ordered list of distinct paths, or path for one image; never both. Paths are workspace-relative or exact absolute paths, including permitted external files and saved input originals. No URLs. Per image: at most 16 MiB source, 32 million pixels and 16384 pixels per side; apply EXIF, use the first animation frame, fit inside 2048 pixels without enlarging, and publish PNG at most 8 MiB. All output PNGs together must fit 16 MiB. Process sequentially; if any image fails or a limit is exceeded, the whole call fails and no images are delivered to the model. Metadata and visual inputs follow the requested order. Read-only; no edit baseline. Failures do not authorize another path or permission bypass.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      oneOf: [{ required: ['path'] }, { required: ['paths'] }],
      properties: {
        path: {
          type: 'string',
          description:
            'One local image path. Relative paths use the current workspace root; absolute paths may refer to workspace files, permitted external files, or saved input originals authorized for this session. No URLs. Provide either path or paths, never both. For multiple images, use paths (at most 10).',
          minLength: 1,
          maxLength: 4096,
        },
        paths: {
          type: 'array',
          description:
            'An ordered list of 1 to 10 distinct local image paths. Relative paths use the current workspace root; absolute paths may refer to workspace files, permitted external files, or saved input originals authorized for this session. No URLs. Images are processed and delivered to the model in list order. Provide either paths or path, never both.',
          minItems: 1,
          maxItems: imageBatchCount,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 4096 },
        },
      },
    },
    resources: { serial: { scope: 'runtime', key: 'files.view_images' }, slot: 'process' },
    contextDiscovery: 'read_only',
    async execute(input, context) {
      if (!context.artifacts) throw new AgentError('artifact_publication_unavailable');
      const images: { png: Uint8Array; metadata: Record<string, Json> }[] = [];
      try {
        const paths = imagePaths(input);
        const read = typeof source === 'function' ? source : await source.prepare(paths, context);
        let size = 0;
        for (const path of paths) {
          const result = await processImage(async (signal) => {
            const value = await read(path, context, signal);
            signal.throwIfAborted();
            if (value.bytes.length > imageInputBytes) throw new AgentError('image_input_too_large');
            return value;
          }, context.signal);
          context.signal.throwIfAborted();
          size += result.png.length;
          if (size > imageBatchBytes) throw new AgentError('image_batch_too_large');
          images.push({
            png: result.png,
            metadata: {
              path: result.source.path,
              sourceHash:
                result.source.hash ??
                createHash('sha256').update(result.source.bytes).digest('hex'),
              sourceSize: result.source.bytes.length,
              ...result.metadata,
            },
          });
        }
      } catch (error) {
        if (error instanceof ImageProcessCleanupError) throw error;
        if (error instanceof AgentError && /_(?:unknown|unconfirmed)$/.test(error.code))
          throw error;
        const code = error instanceof AgentError ? error.code : 'image_read_failed';
        return {
          outcome: context.signal.aborted ? 'cancelled' : 'failed',
          content: code,
          details: { code },
        };
      }
      // Publication/integrity failures belong to the Artifact owner; never turn them into a read miss.
      const references: ArtifactRef[] = [];
      for (const [index, image] of images.entries()) {
        context.signal.throwIfAborted();
        references.push(
          await context.artifacts.publish({
            key: images.length === 1 ? 'image' : `image-${index + 1}`,
            content: image.png,
            mediaType: 'image/png',
          }),
        );
      }
      context.signal.throwIfAborted();
      return {
        outcome: 'succeeded',
        content: JSON.stringify(
          images.length === 1
            ? images[0]!.metadata
            : { images: images.map((image) => image.metadata) },
        ),
        artifactRefs: references,
        modelImages: references,
      };
    },
  };
}
