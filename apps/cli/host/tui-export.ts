import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { serializeLoadedText, type TuiExportPort } from '@kite-ai/ui/tui';

/** The selected user configuration directory is host-owned; renderer never supplies a path. */
export function createTuiExporter(configurationDirectory: string, storeId: string): TuiExportPort {
  return {
    async write(snapshot, signal) {
      signal.throwIfAborted();
      if (snapshot.storeId !== storeId) throw new Error('export_store_mismatch');
      const body = serializeLoadedText(snapshot);
      await mkdir(configurationDirectory, { recursive: true, mode: 0o700 });
      signal.throwIfAborted();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const path = join(configurationDirectory, `session-${timestamp}-${crypto.randomUUID()}.md`);
      const file = await open(path, 'wx', 0o600);
      try {
        signal.throwIfAborted();
        await file.writeFile(body, { encoding: 'utf8', signal });
        signal.throwIfAborted();
        await file.sync();
      } catch (error) {
        await file.close();
        await unlink(path).catch(() => {});
        throw error;
      }
      await file.close();
      return { path };
    },
  };
}
