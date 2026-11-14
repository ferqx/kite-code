import type { Message } from '@kite-ai/client';
import { Button, useConversationReadActive } from '@kite-ai/ui/desktop';
import { useEffect, useRef, useState } from 'react';
import { readNativeBodyChunks } from './native-body-chunks';
import type { NativeBridge } from './native-bridge';
import { nativeReadDeadline } from './native-read-deadline';

const displayCharacters = 16_384;
const staleTextErrors = new Set([
  'background_child_binding_changed',
  'invalid_cursor',
  'invalid_request',
  'message_not_found',
  'message_text_changed',
  'message_text_identity_mismatch',
  'native_selection_changed',
  'permission_denied',
  'session_not_found',
  'store_identity_mismatch',
]);

export function NativeMessageText({
  bridge,
  generation,
  viewSelection,
  historyEpoch,
  storeId,
  message,
  available,
  automatic = false,
  active = true,
  childHandle,
}: {
  bridge: NativeBridge;
  generation: number;
  viewSelection?: number;
  historyEpoch?: number;
  storeId: string;
  message: Message;
  available: boolean;
  automatic?: boolean;
  active?: boolean;
  childHandle?: string;
}) {
  const readActive = useConversationReadActive();
  const { id, sessionId, seq, deferredText } = message;
  const byteLength = Number(deferredText?.bytes);
  const sha256 = deferredText?.sha256;
  const canRead = active && available && readActive;
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState(0);
  const [state, setState] = useState<{ text?: string; loading?: boolean; failed?: boolean }>({});
  const [inViewport, setInViewport] = useState(false);
  const preview = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const element = preview.current;
    if (!automatic || state.text !== undefined || !element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) =>
        setInViewport(
          entries.some((entry) => entry.isIntersecting && entry.intersectionRect.height > 0),
        ),
      { root: element.closest('.conversation-viewport') },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [automatic, state.text]);
  useEffect(() => {
    if (
      !(automatic ? inViewport : attempt) ||
      !canRead ||
      !sha256 ||
      !Number.isSafeInteger(byteLength) ||
      byteLength <= 0 ||
      state.text !== undefined
    )
      return;
    let current = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 250;
    const invalid = () => Error('message_text_unavailable');
    if (!automatic) setState({ loading: true });
    async function readText() {
      let retryable = false;
      try {
        const bytes = await readNativeBodyChunks({
          byteLength,
          readId: id,
          kind: 'messages.text',
          check: () => {
            if (!current) throw invalid();
          },
          invalid,
          read: async (offset) => {
            const chunk = await nativeReadDeadline(
              bridge.request(
                childHandle
                  ? {
                      method: 'background.child.text',
                      surface: 'environment',
                      generation,
                      handle: childHandle,
                      offset: String(offset),
                    }
                  : {
                      method: 'messages.text',
                      generation,
                      viewSelection: viewSelection!,
                      historyEpoch: historyEpoch!,
                      messageId: id,
                      offset: String(offset),
                    },
              ),
            ).catch((error: unknown) => {
              const code = (error as { code?: string } | undefined)?.code;
              retryable = !staleTextErrors.has(code ?? (error as Error | undefined)?.message ?? '');
              throw error;
            });
            if (
              !chunk ||
              !('sha256' in chunk) ||
              !('kind' in chunk) ||
              chunk.kind !== 'messages.text' ||
              chunk.storeId !== storeId ||
              chunk.sessionId !== sessionId ||
              chunk.seq !== seq ||
              chunk.messageId !== id ||
              chunk.sha256 !== sha256 ||
              chunk.bytes !== String(byteLength)
            )
              throw invalid();
            return {
              ...chunk,
              readId: chunk.messageId,
              offset: Number(chunk.offset),
              nextOffset: Number(chunk.nextOffset),
              eof: chunk.nextOffset === chunk.bytes,
            };
          },
        });
        const hash = await crypto.subtle.digest('SHA-256', bytes);
        if (
          Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join(
            '',
          ) !== sha256
        )
          throw invalid();
        if (current) setState({ text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) });
      } catch {
        if (!current) return;
        if (!automatic) setState({ failed: true });
        else if (retryable) {
          retry = setTimeout(() => void readText(), delay);
          delay = Math.min(delay * 2, 4_000);
        }
      }
    }
    void readText();
    return () => {
      current = false;
      clearTimeout(retry);
    };
  }, [
    attempt,
    canRead,
    automatic,
    inViewport,
    byteLength,
    sha256,
    state.text,
    bridge,
    generation,
    viewSelection,
    childHandle,
    historyEpoch,
    storeId,
    sessionId,
    seq,
    id,
  ]);
  const complete = state.text;
  const start = page * displayCharacters;
  const safeBoundary = (position: number) =>
    complete && /[\uD800-\uDBFF]/.test(complete[position - 1] ?? '') ? position - 1 : position;
  const pageText = complete?.slice(safeBoundary(start), safeBoundary(start + displayCharacters));
  return (
    <>
      <pre ref={preview} className="tool-detail">
        {pageText ?? message.content.slice(0, 360)}
      </pre>
      {!automatic && state.text === undefined && (
        <Button
          variant="ghost"
          disabled={!available || !readActive || !!state.loading}
          onClick={() => setAttempt((value) => value + 1)}
        >
          {state.failed ? '重试读取完整记录' : '读取完整记录'}
        </Button>
      )}
      {complete && complete.length > displayCharacters && (
        <div>
          <Button
            variant="ghost"
            disabled={page === 0}
            onClick={() => setPage((value) => value - 1)}
          >
            上一段
          </Button>
          <Button
            variant="ghost"
            disabled={start + displayCharacters >= complete.length}
            onClick={() => setPage((value) => value + 1)}
          >
            下一段
          </Button>
        </div>
      )}
    </>
  );
}
