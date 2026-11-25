import { mkdtemp, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { documentTemporaryRoot, exportDocument, readBoundedDocument } from './document-export';
import { readPdf } from './pdf';

export async function readPdfForShell(options: {
  input: string;
  mode: 'text' | 'image';
  pages?: string;
  out?: string;
  signal: AbortSignal;
}) {
  const { input, mode, pages, out, signal } = options;
  const source = resolve(input);
  const bytes = await readBoundedDocument(source, undefined, signal);
  const result = await readPdf(bytes, { pages, mode }, signal);
  const summary = {
    success: true,
    path: source,
    totalPages: result.totalPages,
    nextPage: result.nextPage,
  };
  if (mode === 'image') {
    if (!out) throw Error('documents_arguments_invalid');
    const directory = await mkdtemp(join(await realpath(out), 'kite-pdf-pages-'));
    const files: { number: number; label: string | null; path: string }[] = [];
    try {
      for (const { number, label, image } of result.pages) {
        signal.throwIfAborted();
        if (!image) throw Error('pdf_worker_failed');
        const path = join(directory, `page-${number}.png`);
        files.push({ number, label, path });
        await writeFile(path, image, { flag: 'wx', mode: 0o600, signal });
      }
      signal.throwIfAborted();
      return { ...summary, pages: files };
    } catch (error) {
      try {
        for (const { path } of files) {
          await unlink(path).catch((failure) => {
            if (failure.code !== 'ENOENT') throw failure;
          });
        }
        await rmdir(directory);
      } catch {
        throw Error('pdf_render_cleanup_unknown', { cause: error });
      }
      throw error;
    }
  }

  const extracted = result.pages.map(({ number, label, text }) => ({
    number,
    label,
    text,
    extraction: text.trim() ? 'text_extracted_reading_order_not_guaranteed' : 'no_extractable_text',
  }));
  const data = { ...summary, pages: extracted };
  const json = JSON.stringify(data);
  if (!out) {
    if (Buffer.byteLength(json) > 48 * 1024)
      throw Error('pdf_text_output_limit: Choose fewer pages or use --out <new-json-file>.');
    return data;
  }
  const directory = await mkdtemp(join(documentTemporaryRoot(), 'kite-pdf-text-'));
  const temporary = join(directory, 'text.json');
  try {
    await writeFile(temporary, json, { flag: 'wx', mode: 0o600, signal });
    const outputPath = resolve(out);
    await exportDocument(temporary, outputPath, signal);
    return {
      ...summary,
      outputPath,
      pages: extracted.map(({ number, label, extraction }) => ({ number, label, extraction })),
    };
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await rmdir(directory);
  }
}
