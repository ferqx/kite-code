import { ClientError, type ModelInputPage, verifyModelInputSnapshot } from '@kite-ai/client';
import type { ModelInputPort } from '@kite-ai/ui';
import type { NativeBridge } from './native-bridge';
import { type NativeModelBodyRead, readNativeModelBody } from './native-model-output';

export function readNativeModelInput(input: NativeModelBodyRead) {
  return readNativeModelBody(input, 'modelInput', verifyModelInputSnapshot);
}
/** Public shared Inspector adapter. It retains no body and has no execution mutation methods. */
export function createNativeModelInputPort(input: {
  bridge: NativeBridge;
  generation: number;
  storeId: string;
  sessionId: string;
  enabled: boolean;
  isCurrent: () => boolean;
}): ModelInputPort {
  const check = (sessionId: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (sessionId !== input.sessionId || !input.isCurrent())
      throw new ClientError('native_selection_changed');
  };
  return {
    serverInfo: {
      storeId: input.storeId,
      capabilities: input.enabled ? ['model_inputs'] : [],
      dataAvailability: 'available',
    },
    async listModelInputs(sessionId, options) {
      check(sessionId, options.signal);
      const readId = crypto.randomUUID();
      const close = () => {
        void input.bridge
          .request({ method: 'modelInputs.close', generation: input.generation, readId })
          .catch(() => {});
      };
      options.signal?.addEventListener('abort', close, { once: true });
      try {
        const raw = await input.bridge.request({
          method: 'modelInputs.list',
          generation: input.generation,
          readId,
          expectedStoreId: input.storeId,
          sessionId,
          afterSeq: options.afterSeq,
          upperSeq: options.upperSeq,
          limit: options.limit ?? 200,
        });
        check(sessionId, options.signal);
        if (
          !raw ||
          !('items' in raw) ||
          raw.storeId !== input.storeId ||
          raw.sessionId !== sessionId
        )
          throw new ClientError('model_input_identity_mismatch');
        return raw as ModelInputPage;
      } finally {
        options.signal?.removeEventListener('abort', close);
      }
    },
    getModelInput(sessionId, executionId, options) {
      check(sessionId, options.signal);
      return readNativeModelInput({
        bridge: input.bridge,
        generation: input.generation,
        expectedStoreId: input.storeId,
        sessionId,
        executionId,
        signal: options.signal ?? new AbortController().signal,
        isCurrent: input.isCurrent,
      });
    },
  };
}
