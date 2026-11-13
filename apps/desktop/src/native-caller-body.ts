import type { NativeBridge } from './native-bridge';

export async function readNativeCallerBody({
  bridge,
  generation,
  commandId,
  bodyDigest,
  readId,
  owned,
}: {
  bridge: NativeBridge;
  generation: number;
  commandId: string;
  bodyDigest: string;
  readId: string;
  owned: () => boolean;
}) {
  let text = '',
    offset = 0;
  while (owned()) {
    const page = await bridge.request({
      method: 'caller.body',
      generation,
      commandId,
      readId,
      offset,
      limit: 65536,
    });
    if (!owned()) return undefined;
    if (
      !page ||
      !('readId' in page) ||
      !('kind' in page) ||
      page.kind !== 'caller.body' ||
      page.readId !== readId ||
      page.commandId !== commandId ||
      page.offset !== offset ||
      page.bodyDigest !== bodyDigest
    )
      throw Error('caller_body_identity');
    text += page.data;
    if (page.eof) {
      const bytes = new TextEncoder().encode(text);
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
      if (digest !== bodyDigest || bytes.length !== page.bodyBytes) throw Error('caller_body_hash');
      return owned() ? text : undefined;
    }
    if (page.nextOffset <= offset) throw Error('caller_body_gap');
    offset = page.nextOffset;
  }
  return undefined;
}
