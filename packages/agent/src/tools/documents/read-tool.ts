import type { Json, ToolContext, ToolResult } from '../../extensions';
import { AgentError } from '../../storage/types';
import type { FileBaseline } from '../files';
import { pdfRecipe, readCachedPdf, readPdf } from './pdf';

export const pdfPages = {
  type: 'string',
  pattern: '^[1-9][0-9]*(-[1-9][0-9]*)?$',
  maxLength: 32,
  description: 'Physical PDF pages, starting at 1. Supply a page or range such as "1-4".',
};

export async function readPdfToolResult(input: {
  path: string;
  request: Record<string, Json>;
  context: ToolContext;
  source: { bytes: Uint8Array; baseline: FileBaseline };
  cache?: { profilePath: string; storeId: string };
  verify?(): Promise<void>;
}): Promise<ToolResult> {
  const { path, request, context, source, cache, verify } = input;
  if (request.offset !== undefined || request.limit !== undefined)
    throw new AgentError('pdf_requires_page_range');
  if (!context.artifacts) throw new AgentError('artifact_publication_unavailable');
  const mode = typeof request.mode === 'string' ? request.mode : 'image';
  const range = {
    pages: typeof request.pages === 'string' ? request.pages : undefined,
    mode,
    ...(mode === 'image' ? { textLayer: true } : {}),
  };
  const sourceHash = source.baseline.hash;
  const parsed = cache
    ? await readCachedPdf(source.bytes, range, { ...cache, sourceHash }, context.signal)
    : await readPdf(source.bytes, range, context.signal);
  await verify?.();
  context.signal.throwIfAborted();
  const modelImages = [];
  for (const page of parsed.pages) {
    if (!page.image) continue;
    modelImages.push(
      await context.artifacts.publish({
        key: `pdf-page-${page.number}`,
        content: page.image,
        mediaType: 'image/png',
      }),
    );
  }
  const content = JSON.stringify({
    path,
    sourceHash,
    recipe: pdfRecipe,
    totalPages: parsed.totalPages,
    nextPage: parsed.nextPage,
    mode,
    pages: parsed.pages.map((page) => {
      const text =
        page.text ||
        (page.textLayer?.items ?? [])
          .map((item) => item.text + (item.hasEOL ? '\n' : ' '))
          .join('')
          .trim();
      return {
        number: page.number,
        label: page.label,
        text,
        extraction: page.image
          ? 'page_image'
          : text
            ? 'text_extracted_reading_order_not_guaranteed'
            : 'no_extractable_text',
      };
    }),
  });
  const reference = await context.artifacts.publish({
    key: 'pdf-read-result',
    content: Buffer.from(content),
    mediaType: 'application/json',
  });
  return {
    outcome: 'succeeded',
    content:
      Buffer.byteLength(content) < 65536
        ? content
        : JSON.stringify({
            path,
            totalPages: parsed.totalPages,
            nextPage: parsed.nextPage,
            pages: parsed.pages.map((page) => page.number),
          }),
    artifactRefs: [reference, ...modelImages],
    modelContent: { kind: 'artifact', reference, encoding: 'utf-8' },
    ...(modelImages.length ? { modelImages } : {}),
  };
}
