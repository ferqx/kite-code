import { createHash, randomUUID } from 'node:crypto';
import { type FileHandle, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentClient, OutputFileTarget } from '@kite-ai/client';

/** A destination is host-selected, never supplied by the renderer. EOF + integrity precede rename. */
export async function saveOutputFile(
  client: AgentClient,
  target: OutputFileTarget,
  destination: string,
  current: () => void,
) {
  current();
  const { reference, content, cancel } = await client.readOutputFileStream(target);
  const temporary = join(dirname(destination), `.kite-save-${randomUUID()}.tmp`);
  let file: FileHandle | undefined;
  let size = 0n;
  const hash = createHash('sha256');
  try {
    current();
    file = await open(temporary, 'wx', 0o600);
    for await (const chunk of content) {
      current();
      size += BigInt(chunk.byteLength);
      if (size > BigInt(reference.size)) throw Error('output_file_integrity_failed');
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const written = await file.write(chunk, offset, chunk.byteLength - offset);
        if (!written.bytesWritten) throw Error('output_file_write_failed');
        offset += written.bytesWritten;
      }
    }
    if (String(size) !== reference.size || hash.digest('hex') !== reference.hash)
      throw Error('output_file_integrity_failed');
    await file.sync();
    await file.close();
    current();
    await rename(temporary, destination);
  } finally {
    await cancel().catch(() => {});
    await file?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}
