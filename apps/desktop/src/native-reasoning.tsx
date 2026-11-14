import { useConversationReadActive } from '@kite-ai/ui/desktop';
import { useEffect, useRef, useState } from 'react';

/** The trace requests only the public reasoning text and closes an in-flight read on disclosure. */
export function NativeReasoning({
  open,
  revision,
  read,
}: {
  open: boolean;
  revision: string;
  read?: (signal: AbortSignal) => Promise<string>;
}) {
  const readActive = useConversationReadActive();
  const reader = useRef(read);
  reader.current = read;
  const [result, setResult] = useState<{ text?: string; failed?: boolean }>();
  const available = !!read;
  // The scoped host reader changes with each render; the public message revision owns this read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision selects the current public body.
  useEffect(() => {
    if (!open || !readActive || !available) return;
    const controller = new AbortController();
    void reader.current?.(controller.signal).then(
      (text) => {
        if (!controller.signal.aborted) setResult({ text });
      },
      () => {
        if (!controller.signal.aborted) setResult((previous) => ({ ...previous, failed: true }));
      },
    );
    return () => controller.abort();
  }, [open, readActive, available, revision]);
  return (
    <>
      {result?.text && <pre>{result.text}</pre>}
      {open && ((!available && !result?.text) || result?.failed || result?.text === '') && (
        <p role="status">暂时无法读取思考内容，重新展开可重试。</p>
      )}
    </>
  );
}
