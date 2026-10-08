import {
  type BackgroundExecutionItem,
  ClientError,
  verifyModelOutputSnapshot,
} from '@kite-ai/client';
import { type NativeBackgroundChild, nativeBackgroundPageBytes } from './background-bridge';
import type { NativeBridge } from './native-bridge';

const decimal = (value: string) => {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 9223372036854775807n)
    throw new ClientError('background_identity_mismatch');
  return BigInt(value);
};
export type BackgroundRead = {
  bridge: NativeBridge;
  generation: number;
  storeId: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
  environment?: { rootSessionId: string; viewSelection: number };
};
export async function readNativeBackground(input: BackgroundRead) {
  const surface = input.environment ? { surface: 'environment' as const } : {};
  const readId = crypto.randomUUID(),
    items: BackgroundExecutionItem[] = [],
    ids = new Set<string>();
  let offset = 0,
    total: number | undefined,
    observationId: number | undefined,
    lastSeq = 0n;
  const close = () =>
    input.bridge
      .request({ method: 'background.close', generation: input.generation, readId, ...surface })
      .catch(() => undefined);
  const check = () => {
    input.signal.throwIfAborted();
    if (!input.isCurrent()) throw new ClientError('background_observation_changed');
  };
  const abort = () => {
    void close();
  };
  input.signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      check();
      const page = await input.bridge.request({
        method: offset ? 'background.next' : 'background.open',
        generation: input.generation,
        readId,
        ...surface,
      });
      check();
      if (
        !page ||
        !('readId' in page) ||
        page.kind !== 'background.page' ||
        page.viewGeneration !== input.generation ||
        page.storeId !== input.storeId ||
        page.readId !== readId ||
        (input.environment &&
          (page.rootSessionId !== input.environment.rootSessionId ||
            page.viewSelection !== input.environment.viewSelection)) ||
        !Number.isSafeInteger(page.observationId) ||
        page.observationId < 1 ||
        (observationId !== undefined && page.observationId !== observationId) ||
        !Number.isSafeInteger(page.total) ||
        page.total < 0 ||
        (total !== undefined && page.total !== total) ||
        !Array.isArray(page.entries) ||
        page.startIndex !== offset ||
        page.nextIndex !== offset + page.entries.length ||
        page.nextIndex > page.total ||
        page.complete !== (page.nextIndex === page.total) ||
        (!page.complete && !page.entries.length) ||
        page.entries.length > 200 ||
        new TextEncoder().encode(JSON.stringify(page)).byteLength > nativeBackgroundPageBytes
      )
        throw new ClientError('background_page_invalid');
      for (const item of page.entries) {
        if (
          decimal(item.seq) <= lastSeq ||
          ids.has(item.execution.id) ||
          item.execution.kind !== 'job' ||
          !item.execution.originStoreId ||
          item.execution.sessionId !== item.session.id ||
          item.execution.rootSessionId !== item.rootSession.id ||
          item.session.rootSessionId !== item.rootSession.id ||
          item.rootSession.parentSessionId !== null ||
          (input.environment && item.rootSession.id !== input.environment.rootSessionId) ||
          item.rootSession.rootSessionId !== item.rootSession.id ||
          item.session.workspaceId !== item.rootSession.workspaceId ||
          item.session.deletedAt !== null ||
          item.rootSession.deletedAt !== null ||
          (item.execution.childSessionId !== null &&
            (!item.childSession ||
              item.childSession.id !== item.execution.childSessionId ||
              item.childSession.parentSessionId !== item.session.id ||
              item.childSession.rootSessionId !== item.rootSession.id ||
              item.childSession.workspaceId !== item.session.workspaceId)) ||
          (item.childRun !== null &&
            (item.childRun.sessionId !== item.execution.childSessionId ||
              item.childRun.originCommandId !== `child-start-${item.execution.id}` ||
              item.childRun.originStoreId !== item.execution.originStoreId)) ||
          (item.run !== null &&
            (item.run.sessionId !== item.session.id ||
              item.run.originStoreId !== item.execution.originStoreId ||
              item.run.rootWorkCommandId !== item.execution.rootWorkCommandId ||
              item.run.rootWorkSeq !== item.execution.rootWorkSeq))
        )
          throw new ClientError('background_identity_mismatch');
        ids.add(item.execution.id);
        lastSeq = decimal(item.seq);
        items.push(item);
      }
      total = page.total;
      observationId = page.observationId;
      offset = page.nextIndex;
      if (page.complete) return { items, observationId, storeId: input.storeId };
    }
  } finally {
    input.signal.removeEventListener('abort', abort);
    await close();
  }
}

export async function readNativeBackgroundChild(
  input: BackgroundRead & { observationId: number; item: BackgroundExecutionItem },
): Promise<NativeBackgroundChild> {
  const surface = input.environment ? { surface: 'environment' as const } : {};
  const readId = crypto.randomUUID(),
    executionId = input.item.execution.id,
    childId = input.item.execution.childSessionId;
  const close = () =>
    input.bridge
      .request({
        method: 'background.child.close',
        generation: input.generation,
        readId,
        ...surface,
      })
      .catch(() => undefined);
  const check = () => {
    input.signal.throwIfAborted();
    if (!input.isCurrent()) throw new ClientError('background_observation_changed');
  };
  const abort = () => {
    void close();
  };
  input.signal.addEventListener('abort', abort, { once: true });
  try {
    check();
    const opened = await input.bridge.request({
      method: 'background.child.open',
      generation: input.generation,
      observationId: input.observationId,
      executionId,
      readId,
      ...surface,
    });
    check();
    if (
      !opened ||
      !('readId' in opened) ||
      opened.kind !== 'background.child.opened' ||
      opened.readId !== readId ||
      (input.environment &&
        (opened.rootSessionId !== input.environment.rootSessionId ||
          opened.viewSelection !== input.environment.viewSelection)) ||
      opened.viewGeneration !== input.generation ||
      opened.storeId !== input.storeId ||
      opened.observationId !== input.observationId ||
      opened.executionId !== executionId ||
      opened.childSessionId !== childId ||
      opened.childRunId !== (input.item.childRun?.id ?? null) ||
      typeof opened.wireBytes !== 'string' ||
      !/^[1-9][0-9]*$/.test(opened.wireBytes) ||
      BigInt(opened.wireBytes) > BigInt(Number.MAX_SAFE_INTEGER) ||
      !/^[a-f0-9]{64}$/.test(opened.wireHash)
    )
      throw new ClientError('background_child_invalid');
    const bytes = new Uint8Array(Number(opened.wireBytes));
    let offset = 0;
    for (;;) {
      check();
      const chunk = await input.bridge.request({
        method: 'background.child.read',
        generation: input.generation,
        readId,
        offset,
        limit: 65536,
        ...surface,
      });
      check();
      if (
        !chunk ||
        !('readId' in chunk) ||
        chunk.kind !== 'background.child.chunk' ||
        chunk.readId !== readId ||
        chunk.offset !== offset ||
        !Number.isSafeInteger(chunk.nextOffset) ||
        typeof chunk.eof !== 'boolean' ||
        typeof chunk.data !== 'string' ||
        chunk.data.length > 87384 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data)
      )
        throw new ClientError('background_child_chunk_invalid');
      const binary = atob(chunk.data),
        next = offset + binary.length;
      if (
        binary.length > 65536 ||
        next !== chunk.nextOffset ||
        next > bytes.length ||
        (!chunk.eof && binary.length === 0) ||
        chunk.eof !== (next === bytes.length)
      )
        throw new ClientError('background_child_chunk_invalid');
      for (let i = 0; i < binary.length; i++) bytes[offset + i] = binary.charCodeAt(i);
      offset = next;
      if (chunk.eof) break;
    }
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('');
    check();
    if (hash !== opened.wireHash) throw new ClientError('background_child_hash_mismatch');
    const body = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as NativeBackgroundChild;
    if (
      body.item.execution.id !== executionId ||
      body.item.execution.childSessionId !== childId ||
      body.item.execution.originStoreId !== input.item.execution.originStoreId ||
      body.item.session.id !== input.item.session.id ||
      body.item.rootSession.id !== input.item.rootSession.id ||
      (body.item.childRun?.id ?? null) !== opened.childRunId ||
      body.session.id !== childId ||
      body.session.parentSessionId !== input.item.session.id ||
      body.session.rootSessionId !== input.item.rootSession.id ||
      body.session.workspaceId !== input.item.session.workspaceId ||
      !Array.isArray(body.messages) ||
      !Array.isArray(body.modelOutputs)
    )
      throw new ClientError('background_child_invalid');
    let lastSeq = 0n;
    const messages = new Map<string, NativeBackgroundChild['messages'][number]>();
    for (const message of body.messages) {
      if (
        message.sessionId !== childId ||
        decimal(message.seq) <= lastSeq ||
        decimal(message.seq) > decimal(body.upperSeq) ||
        messages.has(message.id)
      )
        throw new ClientError('background_child_history_mismatch');
      lastSeq = decimal(message.seq);
      messages.set(message.id, message);
    }
    const outputs = new Set<string>();
    for (const entry of body.modelOutputs) {
      const message = messages.get(entry.messageId),
        snapshot = await verifyModelOutputSnapshot(entry.snapshot, input.signal);
      check();
      if (
        !message?.outputBody ||
        outputs.has(entry.messageId) ||
        snapshot.storeId !== input.storeId ||
        snapshot.rootSessionId !== input.item.rootSession.id ||
        snapshot.sessionId !== (message.originMessage?.sessionId ?? childId) ||
        snapshot.executionId !== message.outputBody.executionId ||
        snapshot.runId !== (message.originMessage ? message.originMessage.runId : message.runId) ||
        snapshot.output.complete !== message.outputBody.complete ||
        snapshot.contentBytes !== message.outputBody.contentBytes ||
        snapshot.reasoningBytes !== message.outputBody.reasoningBytes ||
        snapshot.output.toolCalls.length !== message.outputBody.toolCallCount
      )
        throw new ClientError('background_child_history_mismatch');
      entry.snapshot = snapshot;
      outputs.add(entry.messageId);
    }
    for (const message of body.messages)
      if (
        message.outputBody &&
        message.outputBody.readAvailability !== 'unsupported' &&
        message.contentFormat !== 'unsupported' &&
        !outputs.has(message.id)
      )
        throw new ClientError('background_child_history_mismatch');
    return body;
  } finally {
    input.signal.removeEventListener('abort', abort);
    await close();
  }
}
