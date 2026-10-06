import { ClientError, type ExecutionOutputPage, ExecutionOutputPages } from '@kite-ai/client';
import {
  type NativeJobOutputPage,
  type NativeJobOutputScope,
  nativeJobOutputPageBytes,
} from './job-output-bridge';
import type { NativeBridge } from './native-bridge';

export async function readNativeJobOutput(input: {
  bridge: NativeBridge;
  scope: NativeJobOutputScope;
  signal: AbortSignal;
  isCurrent: () => boolean;
  background?: boolean;
}): Promise<ExecutionOutputPage> {
  const scope = { ...input.scope },
    readId = crypto.randomUUID();
  let closed = false,
    pages: ExecutionOutputPages | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    void input.bridge
      .request({
        method: input.background ? 'background.output.close' : 'jobOutput.close',
        generation: scope.generation,
        readId,
      })
      .catch(() => undefined);
  };
  const check = () => {
    if (input.signal.aborted || !input.isCurrent())
      throw new ClientError('job_output_view_changed');
  };
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => {
      close();
      reject(new ClientError('job_output_view_changed'));
    };
  });
  input.signal.addEventListener('abort', abort, { once: true });
  const items: ExecutionOutputPage['items'] = [];
  try {
    while (!pages?.complete) {
      check();
      const result = await Promise.race([
        input.bridge.request(
          pages
            ? {
                method: input.background ? 'background.output.next' : 'jobOutput.next',
                generation: scope.generation,
                readId,
              }
            : input.background
              ? {
                  method: 'background.output.open',
                  generation: scope.generation,
                  readId,
                  observationId: scope.viewSelection,
                  executionId: scope.executionId,
                }
              : {
                  method: 'jobOutput.open',
                  generation: scope.generation,
                  readId,
                  viewSelection: scope.viewSelection,
                  historyEpoch: scope.historyEpoch,
                  executionId: scope.executionId,
                },
        ),
        cancelled,
      ]);
      check();
      if (!result || !('kind' in result) || result.kind !== 'jobOutput.page')
        throw new ClientError('job_output_page_invalid');
      const value = result as NativeJobOutputPage;
      if (typeof value.upperSeq !== 'string') throw new ClientError('job_output_page_invalid');
      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > nativeJobOutputPageBytes)
        throw new ClientError('job_output_page_too_large');
      if (
        value.readId !== readId ||
        !value.scope ||
        Object.keys(scope).some(
          (key) =>
            value.scope[key as keyof NativeJobOutputScope] !==
            scope[key as keyof NativeJobOutputScope],
        )
      )
        throw new ClientError('job_output_identity_mismatch');
      pages ??= new ExecutionOutputPages(scope.executionId, value.upperSeq);
      if (value.upperSeq !== pages.upperSeq || value.afterSeq !== pages.afterSeq)
        throw new ClientError('execution_output_page_conflict');
      const page = pages.accept(value.page);
      if (value.nextAfterSeq !== pages.afterSeq || value.complete !== pages.complete)
        throw new ClientError('execution_output_page_conflict');
      items.push(...page.items);
    }
    check();
    return { items, highWaterSeq: pages.upperSeq! };
  } finally {
    input.signal.removeEventListener('abort', abort);
    close();
  }
}
