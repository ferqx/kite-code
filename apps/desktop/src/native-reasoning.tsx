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
  revision?: string;
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
      bodyKey={key}
      cache={cache}
      open={open}
      settled={original.status === 'complete' && (original.outputBody?.complete ?? true)}
      revision={JSON.stringify([
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
  bodyKey,
  open,
  revision,
  readEpoch,
  settled,
  read,
  cache,
}: {
  bodyKey: string;
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
  // Presentation survives regrouping and revision changes. A cache hit alone grants no read.
  const [body, setBody] = useState(() => cache.get(bodyKey));
  const displayed = useRef(body);
  displayed.current = body;
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
  }, [open, readActive, available, bodyKey, cache, readEpoch]);
  useEffect(() => {
    const current = reading.current;
    if (!open || !current) return;
    current.next = { revision, settled };
    if (current.busy) return;
    current.busy = true;
    const { signal } = current;
    async function readVersion(target: { revision: string; settled: boolean }) {
      const cached = target.settled ? cache.get(bodyKey) : undefined;
      if (cached?.revision === target.revision && cached.readEpoch === readEpoch) return;
      if (!readActive || !available) return;
      const text = await reader.current?.(signal);
      if (!text || signal.aborted) return;
      const previous = displayed.current;
      if (previous?.text === text) {
        cache.set(bodyKey, { ...previous, revision: target.revision, readEpoch });
        return;
      }
      const prepared =
        text.length >= 32768 && typeof Worker !== 'undefined'
          ? await prepareNativeMarkdown(text, signal).catch(() => undefined)
          : undefined;
      if (signal.aborted) return;
      const next = { text, prepared, revision: target.revision, readEpoch };
      cache.set(bodyKey, next);
      startTransition(() =>
        setBody((previous) => (signal.aborted || previous?.text === text ? previous : next)),
      );
    }
    void (async () => {
      while (current.next && !signal.aborted) {
        const target = current.next;
        current.next = undefined;
        await readVersion(target).catch(() => undefined);
      }
      current.busy = false;
    })();
  }, [open, readActive, available, bodyKey, cache, revision, readEpoch, settled]);
  return body?.text ? <MessageContent text={body.text} prepared={body.prepared} /> : null;
}
