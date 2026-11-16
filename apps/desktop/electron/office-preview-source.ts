const expandedOfficeLimit = 256 * 1024 * 1024;
const zipChunk = 16 * 1024;
const invalidArchive = () => Error('preview_office_archive_invalid');

/** Check one actual raw deflate stream without retaining its expanded data. */
export async function assertOfficeDeflate(data: Uint8Array<ArrayBuffer>, expectedBytes: number) {
  let offset = 0;
  const compressed = new ReadableStream<Uint8Array<ArrayBuffer>>(
    {
      pull(controller) {
        if (offset === data.length) {
          controller.close();
          return;
        }
        const end = Math.min(data.length, offset + zipChunk);
        controller.enqueue(data.subarray(offset, end));
        offset = end;
      },
    },
    { highWaterMark: 0 },
  );
  const reader = compressed.pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > expectedBytes) throw invalidArchive();
    }
    if (length !== expectedBytes) throw invalidArchive();
  } catch {
    await reader.cancel().catch(() => {});
    throw invalidArchive();
  } finally {
    reader.releaseLock();
  }
}

/** Admit one ordinary ZIP directory and verify its actual expansion before rendering. */
export async function assertOfficeArchive(bytes: ArrayBuffer) {
  const view = new DataView(bytes);
  const floor = Math.max(0, view.byteLength - 22 - 65535);
  // Use the final signature, as the downstream ZIP readers do. Reject an ambiguous footer.
  let end = view.byteLength - 4;
  while (end >= floor && view.getUint32(end, true) !== 0x06054b50) end--;
  if (
    end < floor ||
    end + 22 > view.byteLength ||
    end + 22 + view.getUint16(end + 20, true) !== view.byteLength ||
    view.getUint32(end + 4, true) !== 0
  )
    throw invalidArchive();
  const count = view.getUint16(end + 10, true);
  const directory = view.getUint32(end + 16, true);
  if (
    !count ||
    count > 20000 ||
    count !== view.getUint16(end + 8, true) ||
    directory + view.getUint32(end + 12, true) !== end
  )
    throw invalidArchive();
  const deflated: { start: number; size: number; expanded: number }[] = [];
  let offset = directory;
  let expanded = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw invalidArchive();
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const size = view.getUint32(offset + 20, true);
    const expected = view.getUint32(offset + 24, true);
    const local = view.getUint32(offset + 42, true);
    if (
      flags & 1 ||
      (method !== 0 && method !== 8) ||
      view.getUint16(offset + 34, true) !== 0 ||
      local + 30 > directory ||
      view.getUint32(local, true) !== 0x04034b50 ||
      view.getUint16(local + 6, true) !== flags ||
      view.getUint16(local + 8, true) !== method
    )
      throw invalidArchive();
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + size > directory || (method === 0 && size !== expected)) throw invalidArchive();
    expanded += expected;
    if (expanded > expandedOfficeLimit) throw Error('preview_office_archive_budget');
    if (method === 8) deflated.push({ start, size, expanded: expected });
    offset +=
      46 +
      view.getUint16(offset + 28, true) +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
  }
  if (offset !== end) throw invalidArchive();
  for (const part of deflated)
    await assertOfficeDeflate(new Uint8Array(bytes, part.start, part.size), part.expanded);
}

export function startOfficePreview(
  source: string,
  render: (element: HTMLElement, bytes: ArrayBuffer) => Promise<void>,
) {
  const ready = (async () => {
    const element = document.getElementById('office-preview');
    if (!element) throw Error('preview_office_root_missing');
    const response = await fetch(new URL(source, location.href), { credentials: 'omit' });
    if (!response.ok) throw Error('preview_office_source_unavailable');
    const bytes = await response.arrayBuffer();
    await assertOfficeArchive(bytes);
    await render(element, bytes);
    return true;
  })();
  void ready.catch(() => {});
  Object.assign(globalThis, { kiteOfficePreviewReady: ready });
}

/** Scale the document pages while keeping the shared page rail at interface size. */
export function fitOfficePages(
  root: HTMLElement,
  pages: readonly HTMLElement[],
  onLayout?: () => void,
) {
  const sizes = pages.map((page) => {
    const surface = page.firstElementChild as HTMLElement;
    return { width: Math.max(1, surface.offsetWidth), height: Math.max(1, surface.offsetHeight) };
  });
  let previous = '';
  const layout = () => {
    const documentStyle = document.documentElement.style;
    const fit = document.documentElement.dataset.kiteOfficeFit !== 'false';
    const presentation = document.body.classList.contains('kite-present');
    const width = Math.max(1, root.clientWidth - 20);
    const height = presentation ? Math.max(1, innerHeight - 20) : Infinity;
    const signature = `${fit}:${documentStyle.zoom}:${width}:${height}`;
    if (signature === previous) return;
    previous = signature;
    for (const [index, page] of pages.entries()) {
      const size = sizes[index]!;
      page.style.zoom = String(fit ? Math.min(1, width / size.width, height / size.height) : 1);
    }
    onLayout?.();
  };
  new ResizeObserver(layout).observe(root, { box: 'border-box' });
  window.addEventListener('resize', layout);
  layout();
}
