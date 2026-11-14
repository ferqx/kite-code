import type { Message } from '@kite-ai/client';
import {
  type Message as DesktopMessage,
  MessageContent,
  type PreparedDesktopMarkdown,
  useConversationReadActive,
} from '@kite-ai/ui/desktop';
import { startTransition, useEffect, useRef, useState } from 'react';
import type { NativeDisplayCache } from './native-display-cache';
import { prepareNativeMarkdown } from './native-markdown';

export type NativeReasoningBody = { text: string; prepared?: PreparedDesktopMarkdown };

export function renderNativeReasoning({
  scope,
  model,
  original,
  open,
  revision,
  read,
  cache,
}: {
  scope: string;
  model: DesktopMessage;
  original?: Message;
  open: boolean;
  revision?: string;
  read?: (signal: AbortSignal) => Promise<string>;
  cache: NativeDisplayCache<NativeReasoningBody>;
}) {
  if (!original) return null;
  const key = JSON.stringify([
    scope,
    original.id,
    original.originMessage,
    original.runId,
    original.sourceIds?.[0],
  ]);
  return (
    <NativeReasoning
      key={key}
      cache={cache}
      open={open}
      settled={model.settled && original.status === 'complete'}
      revision={JSON.stringify([
        key,
        original.status,
        original.outputBody?.reasoningBytes,
        revision,
        model.settled,
      ])}
      read={read}
    />
  );
}

/** The trace requests only the public reasoning text and closes an in-flight read on disclosure. */
export function NativeReasoning({
  open,
  revision,
  settled,
  read,
  cache,
}: {
  open: boolean;
  revision: string;
  settled: boolean;
  read?: (signal: AbortSignal) => Promise<string>;
  cache: NativeDisplayCache<NativeReasoningBody>;
}) {
  const readActive = useConversationReadActive();
  const reader = useRef(read);
  reader.current = read;
  const available = !!read;
  const [result, setResult] = useState<{ body?: NativeReasoningBody; failed?: boolean }>(() => ({
    body: open && readActive && available && settled ? cache.get(revision) : undefined,
  }));
  // The scoped host reader changes with each render; the public message revision owns this read.
  useEffect(() => {
    if (!open || !readActive || !available) return;
    const cached = settled ? cache.get(revision) : undefined;
    if (cached !== undefined) {
      setResult({ body: cached });
      return;
    }
    const controller = new AbortController();
    void (async () => {
      const text = await reader.current?.(controller.signal);
      if (text === undefined || controller.signal.aborted) return;
      const prepared =
        text.length >= 32768 && typeof Worker !== 'undefined'
          ? await prepareNativeMarkdown(text, controller.signal).catch(() => undefined)
          : undefined;
      if (controller.signal.aborted) return;
      const body = { text, prepared };
      if (settled && text) cache.set(revision, body);
      startTransition(() => setResult({ body }));
    })().catch(() => {
      if (!controller.signal.aborted) setResult((previous) => ({ ...previous, failed: true }));
    });
    return () => controller.abort();
  }, [open, readActive, available, cache, revision, settled]);
  return (
    <>
      {result.body?.text && (
        <MessageContent text={result.body.text} prepared={result.body.prepared} />
      )}
      {open &&
        ((!available && !result.body?.text) || result.failed || result.body?.text === '') && (
          <p role="status">暂时无法读取思考内容，重新展开可重试。</p>
        )}
    </>
  );
}
