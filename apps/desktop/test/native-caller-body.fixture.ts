import { createHash } from 'node:crypto';
import type { CallerCommandRequest } from '@kite-ai/client';
import type { Page } from 'playwright';
export async function readNativeCallerRequest(
  page: Page,
  generation: number,
  commandId: string,
): Promise<CallerCommandRequest> {
  const value = await page.evaluate(
    async ({ generation, commandId }) => {
      const readId = crypto.randomUUID();
      let text = '',
        offset = 0,
        hash = '';
      try {
        for (;;) {
          const value = await window.kiteNative!.request({
            method: 'caller.body',
            generation,
            commandId,
            readId,
            offset,
            limit: 65536,
          });
          if (
            !value ||
            !('readId' in value) ||
            !('kind' in value) ||
            value.kind !== 'caller.body' ||
            value.commandId !== commandId ||
            value.offset !== offset ||
            value.readId !== readId
          )
            throw Error('caller_body_identity');
          if (hash && hash !== value.bodyDigest) throw Error('caller_body_changed');
          hash = value.bodyDigest;
          text += value.data;
          if (value.eof) return { text, hash, bytes: value.bodyBytes };
          if (value.nextOffset <= offset) throw Error('caller_body_gap');
          offset = value.nextOffset;
        }
      } finally {
        await window.kiteNative!.request({ method: 'caller.close', generation, readId });
      }
    },
    { generation, commandId },
  );
  if (
    Buffer.byteLength(value.text) !== value.bytes ||
    createHash('sha256').update(value.text).digest('hex') !== value.hash
  )
    throw Error('caller_body_hash');
  return JSON.parse(value.text) as CallerCommandRequest;
}
