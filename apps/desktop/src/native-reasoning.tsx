import type { Message } from '@kite-ai/client';
import {
  MessageContent,
  type PreparedDesktopMarkdown,
  useConversationReadActive,
} from '@kite-ai/ui/desktop';
import { startTransition, useEffect, useRef, useState } from 'react';
import { NativeDisplayCache } from './native-display-cache';
import { prepareNativeMarkdown } from './native-markdown';

export type NativeReasoningBody = {
  text: string;
  prepared?: PreparedDesktopMarkdown;
  readEpoch?: number;
};

/** Body and retained-tree invalidation is observed even when no disclosure is mounted. */
export class NativeReasoningCache extends NativeDisplayCache<NativeReasoningBody> {
  private boundary = '';
  private revoked = false;
  private epoch = 0;

  observe(boundary: string, authorized: boolean | undefined): number {
    const boundaryChanged = boundary !== this.boundary;
    // No selection during navigation carries no new capability information.
    const revoked =
      authorized === false || (authorized === undefined && !boundaryChanged && this.revoked);
    const accessRevoked = revoked && !this.revoked;
    if (boundaryChanged || accessRevoked) this.clear();
    if (accessRevoked) this.epoch++;
    this.boundary = boundary;
    this.revoked = revoked;
    return this.epoch;
  }
}

export function renderNativeReasoning({
  scope,
  original,
  open,
  revision,
  readEpoch,
  authorized = true,
  read,
  cache,
}: {
  scope: string;
  original?: Message;
  open: boolean;
  revision?: string;
  readEpoch?: number;
  authorized?: boolean;
  read?: (signal: AbortSignal) => Promise<string>;
  cache: NativeDisplayCache<NativeReasoningBody>;
}) {
  // A paused reader can retain verified text; an explicit capability revocation cannot.
  if (!authorized || !original) return null;
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
      settled={original.status === 'complete' && (original.outputBody?.complete ?? true)}
      revision={JSON.stringify([
        key,
        original.status,
        original.outputBody?.complete,
        original.outputBody?.reasoningBytes,
        revision,
      ])}
      readEpoch={readEpoch}
      read={read}
    />
  );
}

/** The trace requests only the public reasoning text and closes an in-flight read on disclosure. */
export function NativeReasoning({
  open,
  revision,
  readEpoch,
  settled,
  read,
  cache,
}: {
  open: boolean;
  revision: string;
  readEpoch?: number;
  settled: boolean;
  read?: (signal: AbortSignal) => Promise<string>;
  cache: NativeDisplayCache<NativeReasoningBody>;
}) {
  const readActive = useConversationReadActive();
  const reader = useRef(read);
  reader.current = read;
  const available = !!read;
  const [result, setResult] = useState<{ body?: NativeReasoningBody; failed?: boolean }>(() => ({
    body: settled ? cache.get(revision) : undefined,
  }));
  const displayed = useRef(result.body);
  displayed.current = result.body;
  const reading = useRef<{
    signal: AbortSignal;
    busy: boolean;
    next?: { revision: string; settled: boolean };
  }>(undefined);
  // A newer output revision can wait. Leaving the disclosure or losing admission must cancel immediately.
  // biome-ignore lint/correctness/useExhaustiveDependencies: These values define one reader's lifetime independently of output revisions.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    reading.current = { signal: controller.signal, busy: false };
    return () => {
      controller.abort();
      reading.current = undefined;
    };
  }, [open, readActive, available, cache, readEpoch]);
  useEffect(() => {
    const current = reading.current;
    if (!open || !current) return;
    current.next = { revision, settled };
    if (current.busy) return;
    current.busy = true;
    const { signal } = current;
    const failed = () => {
      if (!signal.aborted)
        setResult((previous) =>
          signal.aborted || previous.body || previous.failed ? previous : { failed: true },
        );
    };
    async function readVersion(target: { revision: string; settled: boolean }) {
      const cached = target.settled ? cache.get(target.revision) : undefined;
      if (cached && (!displayed.current || cached.readEpoch === readEpoch)) {
        if (displayed.current?.text !== cached.text) setResult({ body: cached });
        if (cached.readEpoch === readEpoch) return;
      }
      if (!readActive || !available) return;
      const text = await reader.current?.(signal);
      if (text === undefined || signal.aborted) return;
      if (!text) return failed();
      const previous = displayed.current;
      if (previous?.text === text) {
        if (target.settled) cache.set(target.revision, { ...previous, readEpoch });
        return;
      }
      const prepared =
        text.length >= 32768 && typeof Worker !== 'undefined'
          ? await prepareNativeMarkdown(text, signal).catch(() => undefined)
          : undefined;
      if (signal.aborted) return;
      const body = { text, prepared, readEpoch };
      if (target.settled) cache.set(target.revision, body);
      startTransition(() =>
        setResult((previous) =>
          signal.aborted || previous.body?.text === text ? previous : { body },
        ),
      );
    }
    void (async () => {
      while (current.next && !signal.aborted) {
        const target = current.next;
        current.next = undefined;
        await readVersion(target).catch(failed);
      }
      current.busy = false;
    })();
  }, [open, readActive, available, cache, revision, readEpoch, settled]);
  return (
    <>
      {result.body?.text && (
        <MessageContent text={result.body.text} prepared={result.body.prepared} />
      )}
      {open && !result.body && (!available || result.failed) && (
        <p role="status">暂时无法读取思考内容，重新展开可重试。</p>
      )}
    </>
  );
}
