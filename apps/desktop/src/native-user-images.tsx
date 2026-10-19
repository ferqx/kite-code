import type { InputImage, Message } from '@kite-ai/client';
import {
  AttachmentFileCard,
  Button,
  useConversationReadActive,
  useConversationResourceRetention,
} from '@kite-ai/ui/desktop';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { NativeBridge } from './native-bridge';

type Props = {
  bridge: NativeBridge;
  generation: number;
  viewSelection: number;
  historyEpoch: number;
  message: Message;
  readAvailable: boolean;
};
async function readImage(props: Props, index: number, image: InputImage, signal: AbortSignal) {
  const readId = crypto.randomUUID(),
    { bridge, generation } = props;
  const close = () =>
    bridge.request({ method: 'input.image.close', generation, readId }).catch(() => {});
  signal.addEventListener('abort', close, { once: true });
  try {
    signal.throwIfAborted();
    const opened = await bridge.request({
      method: 'input.image.open',
      generation,
      readId,
      messageId: props.message.id,
      index,
      viewSelection: props.viewSelection,
      historyEpoch: props.historyEpoch,
    });
    signal.throwIfAborted();
    if (
      !opened ||
      typeof opened !== 'object' ||
      !('kind' in opened) ||
      opened.kind !== 'input.image.open' ||
      !('hash' in opened) ||
      !('size' in opened) ||
      opened.readId !== readId ||
      opened.hash !== image.reference.hash ||
      opened.mediaType !== image.reference.mediaType ||
      opened.size !== Number(image.reference.size) ||
      opened.size > 16 * 1024 * 1024
    )
      throw Error('input_image_metadata_invalid');
    const bytes = new Uint8Array(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const chunk = await bridge.request({
        method: 'input.image.read',
        generation,
        readId,
        offset,
      });
      signal.throwIfAborted();
      if (
        !chunk ||
        typeof chunk !== 'object' ||
        !('kind' in chunk) ||
        chunk.kind !== 'input.image.chunk' ||
        !('data' in chunk) ||
        chunk.readId !== readId ||
        chunk.offset !== offset ||
        !chunk.data ||
        chunk.data.length > 87384
      )
        throw Error('input_image_chunk_invalid');
      const data = Uint8Array.from(atob(chunk.data), (char) => char.charCodeAt(0));
      if (
        chunk.nextOffset !== offset + data.length ||
        !data.length ||
        chunk.nextOffset > bytes.length ||
        chunk.done !== (chunk.nextOffset === bytes.length)
      )
        throw Error('input_image_chunk_invalid');
      bytes.set(data, offset);
      offset = chunk.nextOffset;
    }
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
    signal.throwIfAborted();
    if (hash !== image.reference.hash) throw Error('input_image_hash_mismatch');
    return bytes;
  } finally {
    signal.removeEventListener('abort', close);
    await close();
  }
}

// One visible preview at a time per window bridge; do not overrun Main's read leases
// when several historical messages enter the viewport together.
const previewReads = new WeakMap<NativeBridge, Promise<void>>();
function queueImage(props: Props, index: number, image: InputImage, signal: AbortSignal) {
  const pending = (previewReads.get(props.bridge) ?? Promise.resolve()).then(() => {
    signal.throwIfAborted();
    return readImage(props, index, image, signal);
  });
  const tail = pending.then(
    () => {},
    () => {},
  );
  previewReads.set(props.bridge, tail);
  void tail.then(() => {
    if (previewReads.get(props.bridge) === tail) previewReads.delete(props.bridge);
  });
  return pending;
}

function NativeUserImage({ image, index, ...props }: Props & { image: InputImage; index: number }) {
  const readActive = useConversationReadActive();
  const retention = useConversationResourceRetention();
  const readAvailable = props.readAvailable && readActive;
  const [url, setUrl] = useState(''),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [nearby, setNearby] = useState(false),
    [visible, setVisible] = useState(typeof document === 'undefined' || !document.hidden);
  const card = useRef<HTMLDivElement>(null);
  const readScope = JSON.stringify([props.generation, props.viewSelection, props.historyEpoch]);
  const current = useRef({ props, image, index, readAvailable, readScope });
  useLayoutEffect(() => {
    current.current = { props, image, index, readAvailable, readScope };
  });
  const read = useRef<AbortController | undefined>(undefined),
    ownedUrl = useRef(''),
    unregister = useRef<(() => void) | undefined>(undefined);
  const stopRead = useCallback(() => {
    read.current?.abort();
    read.current = undefined;
    setLoading(false);
  }, []);
  const clear = useCallback(() => {
    stopRead();
    unregister.current?.();
    unregister.current = undefined;
    if (ownedUrl.current) URL.revokeObjectURL(ownedUrl.current);
    ownedUrl.current = '';
    setUrl('');
  }, [stopRead]);
  useEffect(() => {
    const element = card.current;
    if (!element) return;
    const Observer = element.ownerDocument.defaultView?.IntersectionObserver;
    if (!Observer) {
      setNearby(true);
      return;
    }
    const observer = new Observer(
      (entries) => setNearby(entries.some((entry) => entry.isIntersecting)),
      { root: element.closest('.conversation-viewport'), rootMargin: '160px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const document = card.current!.ownerDocument;
    const hide = () => {
      setVisible(!document.hidden);
      if (document.hidden) {
        clear();
        setUrl('');
        setLoading(false);
      }
    };
    setVisible(!document.hidden);
    document.addEventListener('visibilitychange', hide);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      stopRead();
      if (!retention?.isPaused()) clear();
    };
  }, [clear, stopRead, retention]);
  const open = useCallback(
    async (scope = current.current.readScope) => {
      if (
        read.current ||
        ownedUrl.current ||
        !current.current.readAvailable ||
        scope !== current.current.readScope ||
        card.current?.ownerDocument.hidden
      )
        return;
      const abort = new AbortController();
      read.current = abort;
      setLoading(true);
      setError('');
      try {
        const { props, image, index } = current.current;
        const bytes = await queueImage(props, index, image, abort.signal);
        if (read.current !== abort || abort.signal.aborted) return;
        const next = URL.createObjectURL(
          new Blob([bytes.buffer as ArrayBuffer], { type: image.reference.mediaType }),
        );
        ownedUrl.current = next;
        unregister.current = retention?.retain({
          bytes: bytes.byteLength,
          release: clear,
          releaseOnWindowHide: true,
        });
        setUrl(next);
      } catch {
        if (!abort.signal.aborted) setError('图片读取失败，请重试。');
      } finally {
        if (read.current === abort) {
          read.current = undefined;
          setLoading(false);
        }
      }
    },
    [retention, clear],
  );
  useEffect(() => {
    if (!nearby || !visible) clear();
    else if (readAvailable) void open(readScope);
    // Scope changes and Activity deactivation stop pending bytes, retaining verified media.
    return stopRead;
  }, [nearby, visible, readAvailable, readScope, clear, open, stopRead]);
  return (
    <div ref={card} className="composer-attachment native-user-image">
      <div className="composer-attachment-preview">
        {url ? (
          <img src={url} alt={image.name} decoding="async" />
        ) : error ? (
          <Button
            variant="ghost"
            disabled={!readAvailable || loading}
            onClick={() => void open()}
            aria-label={`重试读取图片：${image.name}`}
            title={error}
          >
            读取失败，重试
          </Button>
        ) : (
          <span role="status">正在读取…</span>
        )}
      </div>
      <span className="composer-attachment-name" title={image.name}>
        {image.name}
      </span>
    </div>
  );
}
export function NativeUserImages(props: Props) {
  return (
    <section className="composer-attachments native-user-images" aria-label="消息附件">
      {props.message.files?.map((file, index) => (
        <AttachmentFileCard name={file.name} key={`${index}/${file.uri}`} />
      ))}
      {props.message.images?.map((image, index) => (
        <NativeUserImage
          {...props}
          image={image}
          index={index}
          key={JSON.stringify([
            props.generation,
            props.message.sessionId,
            index,
            props.message.id,
            image.reference,
          ])}
        />
      ))}
    </section>
  );
}
