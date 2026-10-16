/** Transport bytes only; the caller retains its read lease and all identity/content proofs. */
export async function readNativeBodyChunks(input: {
  byteLength: number;
  readId: string;
  kind: string;
  read: (offset: number, limit: number) => Promise<unknown>;
  check: () => void;
  invalid: () => Error;
  incomplete?: () => Error;
}): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = new Uint8Array(input.byteLength);
  let offset = 0;
  for (;;) {
    input.check();
    const chunk = await input.read(offset, 65536);
    input.check();
    if (
      !chunk ||
      typeof chunk !== 'object' ||
      !('kind' in chunk) ||
      chunk.kind !== input.kind ||
      !('readId' in chunk) ||
      chunk.readId !== input.readId ||
      !('offset' in chunk) ||
      chunk.offset !== offset ||
      !('eof' in chunk) ||
      typeof chunk.eof !== 'boolean' ||
      !('data' in chunk) ||
      typeof chunk.data !== 'string' ||
      chunk.data.length > 87384 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data)
    )
      throw input.invalid();
    const binary = atob(chunk.data),
      next = offset + binary.length;
    if (
      binary.length > 65536 ||
      !('nextOffset' in chunk) ||
      chunk.nextOffset !== next ||
      next > bytes.length ||
      (!chunk.eof && binary.length === 0) ||
      chunk.eof !== (next === bytes.length)
    )
      throw (input.incomplete ?? input.invalid)();
    for (let index = 0; index < binary.length; index++)
      bytes[offset + index] = binary.charCodeAt(index);
    offset = next;
    if (chunk.eof) return bytes;
  }
}
