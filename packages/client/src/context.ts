import { ClientError } from './decode';
import type { SelectedContextPage } from './generated/api';
import { parseCursorSequence } from './sse';

/** A restored Store may retain original provenance; publication must still belong to this selection. */
export function verifyContextCompression(page: SelectedContextPage, sessionId: string) {
  const compression = page.compression;
  if (!compression) return page;
  let covered: bigint, published: bigint, upper: bigint;
  try {
    covered = parseCursorSequence(compression.coveredThroughSeq);
    published = parseCursorSequence(compression.publishedSeq);
    upper = parseCursorSequence(page.highWaterSeq);
  } catch {
    throw new ClientError('invalid_compression_response');
  }
  if (
    page.selection.sessionId !== sessionId ||
    compression.sessionId !== sessionId ||
    compression.contextSelectionId !== page.selection.id ||
    published <= covered ||
    published > upper
  )
    throw new ClientError('invalid_compression_response');
  return page;
}
