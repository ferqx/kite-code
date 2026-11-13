import { AgentError, type AgentRuntime, type OutputFileTarget } from '@kite-ai/agent';
import { readCachedPdf } from '@kite-ai/agent/files';

/** UI-only page rendering. It resolves the exact delivery before reading, never model tools. */
export function createOutputPreviews(
  runtime: AgentRuntime,
  profilePath: string,
  subjectId: string,
) {
  return {
    async renderPdfPage(target: OutputFileTarget, page: number, signal: AbortSignal) {
      const record = await runtime.resolveOutputFile({
        expectedStoreId: target.storeId,
        sessionId: target.sessionId,
        subjectId,
        target,
      });
      if (record.mediaType !== 'application/pdf' || BigInt(record.size) > 256n * 1024n * 1024n)
        throw new AgentError('output_preview_unsupported');
      const read = await runtime.readArtifact({
        expectedStoreId: target.storeId,
        sessionId: record.reference.sessionId,
        subjectId,
        refId: record.reference.id,
        scope: record.reference.scope,
        signal,
      });
      const result = await readCachedPdf(
        read.content,
        { pages: String(page), mode: 'image' },
        { profilePath, storeId: target.storeId, sourceHash: record.reference.hash },
        signal,
      );
      const image = result.pages[0];
      if (!image?.image || image.number !== page) throw new AgentError('output_preview_failed');
      return {
        page,
        totalPages: result.totalPages,
        mediaType: 'image/png' as const,
        data: Buffer.from(image.image).toString('base64'),
      };
    },
  };
}
