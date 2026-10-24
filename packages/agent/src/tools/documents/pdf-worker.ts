import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getDocument, VerbosityLevel, version } from 'pdfjs-dist/legacy/build/pdf.mjs';

// Only trusted local package assets and transferred source bytes are accepted.
const assets = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const fontWarning =
  /^Warning: (?:getFontFileType:|Font(?: |Family)|loadFont -|Error during font loading:|TT:|Type1Font:|Type3 font |TrueType Collection |Failed to (?:parse|compile) font|translateFont - fetching |buildFontPaths -|ensureStateFont:)/;
globalThis.fetch = Object.assign(
  async () => {
    throw new Error('document_network_disabled');
  },
  { preconnect() {} },
);
declare const self: Worker;
self.onmessage = async (
  event: MessageEvent<{ bytes: Uint8Array; start: number; count: number; mode: 'text' | 'image' }>,
) => {
  const { bytes, start, count, mode } = event.data;
  if (version !== '6.4.299') {
    self.postMessage({ error: 'pdf_assets_invalid' });
    return;
  }
  // PDF.js catches some embedded-font errors even with stopAtErrors. Its fixed
  // version exposes those failures only as warnings; missingFile also describes
  // valid unembedded fonts and cannot distinguish them. Keep only a bounded
  // failure code inside this one-request Worker, not the matched diagnostics.
  let parsingFailure: 'pdf_font_invalid' | 'pdf_processing_failed' | undefined;
  const originalWarn = console.warn;
  console.warn = (message: unknown, ...rest: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('Warning: ')) {
      if (fontWarning.test(message)) {
        parsingFailure = 'pdf_font_invalid';
        return;
      }
      if (message.startsWith('Warning: FormatError:')) {
        parsingFailure ??= 'pdf_processing_failed';
        return;
      }
    }
    originalWarn(message, ...rest);
  };
  const task = getDocument({
    data: bytes,
    useWorkerFetch: false,
    useSystemFonts: false,
    cMapUrl: join(assets, 'cmaps').replaceAll('\\', '/') + '/',
    cMapPacked: true,
    standardFontDataUrl: join(assets, 'standard_fonts').replaceAll('\\', '/') + '/',
    wasmUrl: join(assets, 'wasm').replaceAll('\\', '/') + '/',
    enableXfa: false,
    isOffscreenCanvasSupported: false,
    stopAtErrors: true,
    verbosity: VerbosityLevel.WARNINGS,
  });
  try {
    const pdf = await task.promise;
    if (start > pdf.numPages) throw new Error('pdf_page_out_of_range');
    const labels = await pdf.getPageLabels();
    const pages = [];
    let total = 0;
    for (let number = start; number <= Math.min(pdf.numPages, start + count - 1); number++) {
      const page = await pdf.getPage(number);
      let text = '',
        image: Uint8Array | undefined;
      if (mode === 'text') {
        const content = await page.getTextContent();
        let lastY: number | undefined;
        for (const item of content.items) {
          if (!('str' in item)) continue;
          const y = item.transform[5];
          if (
            lastY !== undefined &&
            Math.abs(y - lastY) > Math.max(2, item.height * 0.5) &&
            !text.endsWith('\n')
          )
            text += '\n';
          else if (text && !text.endsWith('\n') && !text.endsWith(' ')) text += ' ';
          text += item.str;
          if (item.hasEOL) text += '\n';
          lastY = y;
        }
        total += Buffer.byteLength(text);
      } else {
        const original = page.getViewport({ scale: 1 });
        const scale = Math.min(1.5, 2048 / Math.max(original.width, original.height));
        const viewport = page.getViewport({ scale });
        if (
          !(viewport.width > 0 && viewport.height > 0) ||
          viewport.width * viewport.height > 4194304
        )
          throw new Error('pdf_page_too_large');
        const factory = pdf.canvasFactory as {
          create(
            width: number,
            height: number,
          ): {
            canvas: HTMLCanvasElement & { toBuffer(format: string): Uint8Array };
            context: CanvasRenderingContext2D;
          };
          destroy(value: unknown): void;
        };
        const canvas = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
        try {
          await page.render({ canvas: canvas.canvas, canvasContext: canvas.context, viewport })
            .promise;
          image = new Uint8Array(canvas.canvas.toBuffer('image/png'));
          total += image.byteLength;
        } finally {
          factory.destroy(canvas);
        }
      }
      if (parsingFailure) throw new Error(parsingFailure);
      if (total > 16 * 1024 * 1024) throw new Error('pdf_result_too_large');
      pages.push({
        number,
        label: labels?.[number - 1] ?? null,
        text,
        ...(image ? { image } : {}),
      });
      page.cleanup();
    }
    self.postMessage({
      totalPages: pdf.numPages,
      pages,
      nextPage: start + pages.length <= pdf.numPages ? start + pages.length : null,
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    self.postMessage({
      error:
        name === 'PasswordException'
          ? 'pdf_password_required'
          : name === 'InvalidPDFException'
            ? 'pdf_invalid'
            : error instanceof Error && /^pdf_/.test(error.message)
              ? error.message
              : 'pdf_processing_failed',
    });
  } finally {
    try {
      await task.destroy();
    } finally {
      console.warn = originalWarn;
    }
  }
};
