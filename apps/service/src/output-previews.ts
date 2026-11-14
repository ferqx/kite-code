import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentError, type AgentRuntime, type OutputFileTarget } from '@kite-ai/agent';
import { readCachedPdf } from '@kite-ai/agent/files';

/** UI-only page rendering. It resolves the exact delivery before reading, never model tools. */
export function createOutputPreviews(
  runtime: AgentRuntime,
  profilePath: string,
  subjectId: string,
) {
  let snapshots = 0;
  return {
    async renderPdfSnapshot(
      input: {
        expectedStoreId: string;
        sessionId: string;
        sourceHash: string;
        page: number;
        data: string;
      },
      signal: AbortSignal,
    ) {
      signal.throwIfAborted();
      if ((await runtime.getMetadata()).storeId !== input.expectedStoreId)
        throw new AgentError('store_identity_mismatch');
      if (!(await runtime.getSession(input.sessionId))) throw new AgentError('session_not_found');
      if (snapshots >= 2) throw new AgentError('output_preview_busy');
      const bytes = Buffer.from(input.data, 'base64');
      if (
        bytes.length > 64 * 1024 * 1024 ||
        bytes.toString('base64') !== input.data ||
        createHash('sha256').update(bytes).digest('hex') !== input.sourceHash
      )
        throw new AgentError('output_preview_snapshot_invalid');
      snapshots++;
      let temporary: string | undefined;
      try {
        signal.throwIfAborted();
        temporary = await mkdtemp(join(await realpath(tmpdir()), 'kite-pdf-snapshot-'));
        const result = await readCachedPdf(
          bytes,
          { pages: String(input.page), mode: 'image' },
          { profilePath: temporary, storeId: input.expectedStoreId, sourceHash: input.sourceHash },
          signal,
        );
        signal.throwIfAborted();
        if (!(await runtime.getSession(input.sessionId))) throw new AgentError('session_not_found');
        const image = result.pages[0];
        if (!image?.image || image.number !== input.page)
          throw new AgentError('output_preview_failed');
        return {
          page: input.page,
          totalPages: result.totalPages,
          mediaType: 'image/png' as const,
          data: Buffer.from(image.image).toString('base64'),
        };
      } finally {
        snapshots--;
        if (temporary) await rm(temporary, { recursive: true, force: true });
      }
    },
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
