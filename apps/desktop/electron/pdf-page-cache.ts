import type { PdfTextLayer } from './pdf-preview';

type PdfPage = { data: string; totalPages: number; textLayer?: PdfTextLayer };
/** One preview owner, one verified buffer per page. Failures never become cached successes. */
export function createPdfPageCache(
  initial: PdfPage,
  render: (page: number, signal: AbortSignal) => Promise<PdfPage>,
  signal: AbortSignal,
  current: () => void,
  limits = { page: 8 * 1024 * 1024, total: 256 * 1024 * 1024 },
  onPage?: (page: number, layer: PdfTextLayer | undefined) => void,
) {
  const count = initial.totalPages;
  let first: PdfPage | undefined = initial;
  const pages = new Map<number, Promise<Buffer>>();
  let queue = Promise.resolve(),
    total = 0;
  const dispose = () => {
    pages.clear();
    first = undefined;
    total = 0;
  };
  signal.addEventListener('abort', dispose, { once: true });
  return (page: number): Promise<Buffer> => {
    signal.throwIfAborted();
    current();
    if (!Number.isSafeInteger(page) || page < 1 || page > count)
      throw Error('preview_pdf_page_invalid');
    const cached = pages.get(page);
    if (cached) return cached;
    const task = queue.then(async () => {
      signal.throwIfAborted();
      current();
      const result = page === 1 && first ? first : await render(page, signal);
      signal.throwIfAborted();
      current();
      if (result.totalPages !== count) throw Error('preview_pdf_changed');
      const bytes = Buffer.from(result.data, 'base64');
      if (
        bytes.length > limits.page ||
        total + bytes.length > limits.total ||
        bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
      )
        throw Error('preview_pdf_budget');
      let layer = result.textLayer;
      let layerBytes = layer ? Buffer.byteLength(JSON.stringify(layer)) : 0;
      if (
        layer &&
        (bytes.length + layerBytes > limits.page ||
          total + bytes.length + layerBytes > limits.total)
      ) {
        layer = { ...layer, status: 'unavailable', items: [] };
        layerBytes = Buffer.byteLength(JSON.stringify(layer));
        if (
          bytes.length + layerBytes > limits.page ||
          total + bytes.length + layerBytes > limits.total
        ) {
          layer = undefined;
          layerBytes = 0;
        }
      }
      total += bytes.length + layerBytes;
      onPage?.(page, layer);
      if (page === 1) first = undefined;
      return bytes;
    });
    pages.set(page, task);
    queue = task.then(
      () => {},
      () => {
        if (pages.get(page) === task) pages.delete(page);
      },
    );
    return task;
  };
}
