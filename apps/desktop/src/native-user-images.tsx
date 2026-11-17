import type { Message } from '@kite-ai/client';
import {
  Attachment,
  AttachmentFileCard,
  AttachmentMedia,
  AttachmentTitle,
  Button,
  ImageGallery,
  type ImageGalleryItem,
  MessageAttachments,
  useConversationReadActive,
  useConversationResourceRetention,
} from '@kite-ai/ui/desktop';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { NativeBridge } from './native-bridge';
import { nativeImageDisplaySourceByteLimit } from './native-image-display-bridge';
import type { NativeImageOriginalScope, NativeImagePreviews } from './native-image-previews';

type Props = {
  bridge: NativeBridge;
  generation: number;
  viewSelection: number;
  historyEpoch: number;
  message: Message;
  readAvailable: boolean;
  previews: NativeImagePreviews;
  images?: readonly ImageDescriptor[];
  childHandle?: string;
  originalScope?: () => NativeImageOriginalScope | undefined;
  onOriginalScopeRejected?: (scope: NativeImageOriginalScope | undefined) => void;
};
type ImageDescriptor = {
  name: string;
  reference: { hash?: string; mediaType: string; size: string };
};
// These exact bridge codes prove that the admitted identity/authority was retired.
// Busy, transport and generic read failures remain retryable, not inferred revocations.
const rejectedImageScopes = new Set([
  'input_image_view_changed',
  'tool_images_invalid',
  'native_generation_changed',
  'native_selection_changed',
  'store_identity_mismatch',
  'artifact_scope_denied',
  'permission_denied',
  'artifact_reference_not_found',
  'artifact_reference_mismatch',
  'artifact_metadata_mismatch',
  'background_observation_changed',
  'background_identity_mismatch',
  'background_child_binding_changed',
  'background_child_history_mismatch',
]);
async function readImage(
  props: Props,
  index: number,
  image: ImageDescriptor,
  signal: AbortSignal,
  admitted: () => boolean = () => true,
) {
  let rejected = false;
  const check = () => {
    signal.throwIfAborted();
    if (rejected || !admitted() || (originalScope && props.originalScope?.() !== originalScope))
      throw Error('input_image_read_inactive');
  };
  const originalScope = props.originalScope?.();
  const rejectScope = (error: unknown) => {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (typeof code === 'string' && rejectedImageScopes.has(code)) {
      rejected = true;
      props.previews.retireOriginalScope(originalScope);
      props.onOriginalScopeRejected?.(originalScope);
    }
  };
  const readId = crypto.randomUUID(),
    { bridge, generation } = props;
  const close = () =>
    bridge
      .request(
        props.childHandle
          ? {
              method: 'background.child.image.close',
              surface: 'environment',
              generation,
              readId,
            }
          : { method: 'input.image.close', generation, readId },
      )
      .catch(rejectScope);
  signal.addEventListener('abort', close, { once: true });
  try {
    check();
    const opened = await bridge.request(
      props.childHandle
        ? {
            method: 'background.child.image.open',
            surface: 'environment',
            handle: props.childHandle,
            generation,
            readId,
            index,
          }
        : {
            method: 'input.image.open',
            generation,
            readId,
            messageId: props.message.id,
            index,
            viewSelection: props.viewSelection,
            historyEpoch: props.historyEpoch,
          },
    );
    check();
    if (
      !opened ||
      typeof opened !== 'object' ||
      !('kind' in opened) ||
      opened.kind !== 'input.image.open' ||
      !('hash' in opened) ||
      !('size' in opened) ||
      opened.readId !== readId ||
      !/^[a-f0-9]{64}$/.test(opened.hash) ||
      (image.reference.hash !== undefined && opened.hash !== image.reference.hash) ||
      opened.mediaType !== image.reference.mediaType ||
      opened.size !== Number(image.reference.size) ||
      !Number.isSafeInteger(opened.size) ||
      opened.size < 1 ||
      opened.size > nativeImageDisplaySourceByteLimit
    )
      throw Error('input_image_metadata_invalid');
    const identity = {
      key: JSON.stringify([props.message.id, index, image.reference]),
      hash: opened.hash,
      mediaType: opened.mediaType,
      size: opened.size,
    };
    const cached = props.previews.getOriginal(originalScope, identity);
    if (cached) {
      check();
      return { blob: cached, hash: opened.hash };
    }
    const bytes = new Uint8Array(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      check();
      const chunk = await bridge.request(
        props.childHandle
          ? {
              method: 'background.child.image.read',
              surface: 'environment',
              generation,
              readId,
              offset,
            }
          : {
              method: 'input.image.read',
              generation,
              readId,
              offset,
            },
      );
      check();
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
    check();
    if (hash !== opened.hash) throw Error('input_image_hash_mismatch');
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: image.reference.mediaType });
    check();
    props.previews.rememberOriginal(originalScope, identity, blob);
    return { blob, hash };
  } catch (error) {
    rejectScope(error);
    throw error;
  } finally {
    signal.removeEventListener('abort', close);
    await close();
    check();
  }
}

// Thumbnails and the selected original share Main's existing per-window lease queue.
// Close acknowledgement finishes before the next original or thumbnail may open.
const previewReads = new WeakMap<NativeBridge, Promise<void>>();
function queueRead<T>(bridge: NativeBridge, run: () => Promise<T>) {
  const pending = (previewReads.get(bridge) ?? Promise.resolve()).then(run);
  const tail = pending.then(
    () => {},
    () => {},
  );
  previewReads.set(bridge, tail);
  void tail.then(() => {
    if (previewReads.get(bridge) === tail) previewReads.delete(bridge);
  });
  return pending;
}
function queueImage(
  props: Props,
  index: number,
  image: ImageDescriptor,
  signal: AbortSignal,
  admitted: () => boolean,
) {
  return queueRead(props.bridge, async () => {
    signal.throwIfAborted();
    const { blob, hash } = await readImage(props, index, image, signal, admitted);
    signal.throwIfAborted();
    if (!admitted()) throw Error('input_image_read_inactive');
    return props.previews.prepare(blob, hash, signal);
  });
}

function NativeUserImage({
  image,
  index,
  onPreview,
  ...props
}: Props & { image: ImageDescriptor; index: number; onPreview: () => void }) {
  const readActive = useConversationReadActive();
  const retention = useConversationResourceRetention();
  const readAvailable = props.readAvailable && readActive;
  const [firstFrame, setFirstFrame] = useState(false);
  const [url, setUrl] = useState(''),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [nearby, setNearby] = useState(false),
    [visible, setVisible] = useState(typeof document === 'undefined' || !document.hidden);
  const card = useRef<HTMLDivElement>(null);
  const readScope = JSON.stringify([
    props.generation,
    props.viewSelection,
    props.historyEpoch,
    props.childHandle,
  ]);
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
        const preview = await queueImage(
          props,
          index,
          image,
          abort.signal,
          () =>
            current.current.readAvailable &&
            current.current.readScope === scope &&
            !card.current?.ownerDocument.hidden,
        );
        if (read.current !== abort || abort.signal.aborted) return;
        const next = URL.createObjectURL(preview.blob);
        ownedUrl.current = next;
        unregister.current = retention?.retain({
          bytes: preview.cost,
          release: clear,
          releaseOnWindowHide: true,
        });
        setFirstFrame(preview.frame === 'first');
        setUrl(next);
      } catch {
        if (!abort.signal.aborted) setError('图片预览失败，请重试。');
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
    // Clipping during the tool disclosure's exit animation is not a scroll-away.
    // Keep already verified pixels until Radix unmounts the closing body; pending
    // reads still stop below, and window hiding / normal offscreen release stay intact.
    const closing = card.current?.closest('.tool-activity-content[data-state="closed"]');
    if (!visible || (!nearby && !closing)) clear();
    else if (nearby && readAvailable) void open(readScope);
    // Scope changes and Activity deactivation stop pending bytes, retaining verified media.
    return stopRead;
  }, [nearby, visible, readAvailable, readScope, clear, open, stopRead]);
  return (
    <Attachment ref={card} orientation="vertical" className="composer-attachment native-user-image">
      <AttachmentMedia
        variant="image"
        className="composer-attachment-preview"
        aria-busy={loading || undefined}
      >
        {url ? (
          <button
            type="button"
            className="image-gallery-trigger"
            disabled={!readAvailable}
            aria-label={`预览图片：${image.name}${firstFrame ? '（动画首帧）' : ''}`}
            onClick={onPreview}
          >
            <img src={url} alt={image.name} decoding="async" />
            {firstFrame && <span className="image-preview-frame-label">动画首帧</span>}
          </button>
        ) : error ? (
          <Button
            variant="ghost"
            disabled={!readAvailable || loading}
            onClick={() => void open()}
            aria-label={`重试读取图片：${image.name}`}
            title={error}
          >
            预览失败，重试
          </Button>
        ) : null}
      </AttachmentMedia>
      <AttachmentTitle className="composer-attachment-name" title={image.name}>
        {image.name}
      </AttachmentTitle>
    </Attachment>
  );
}
export function NativeUserImages(props: Props) {
  const images = props.images ?? props.message.images;
  const readActive = useConversationReadActive();
  const readAvailable = props.readAvailable && readActive;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Displayed thumbnails may survive a read recalibration. Full originals may not.
  const scopeKey = JSON.stringify([
    props.generation,
    props.viewSelection,
    props.historyEpoch,
    props.childHandle,
    props.message.sessionId,
    props.message.id,
    images,
  ]);
  const original = useRef<{ key: string; scope: NativeImageOriginalScope } | undefined>(undefined);
  const originalScope = useCallback(
    () => (original.current?.key === scopeKey ? original.current.scope : undefined),
    [scopeKey],
  );
  const onOriginalScopeRejected = useCallback((scope: NativeImageOriginalScope | undefined) => {
    if (!scope || original.current?.scope !== scope) return;
    // Keep the retired identity for a later fresh-open refusal in this same
    // observation; it stays ineligible for both cache lookup and refill.
    setSelectedId(null);
  }, []);
  useLayoutEffect(() => {
    const owner = document;
    const retire = () => {
      const previous = original.current;
      original.current = undefined;
      props.previews.retireOriginalScope(previous?.scope);
    };
    const activate = () => {
      retire();
      if (readAvailable && !owner.hidden)
        original.current = { key: scopeKey, scope: props.previews.createOriginalScope(scopeKey) };
    };
    const visibility = () => {
      if (owner.hidden) retire();
      else activate();
    };
    activate();
    owner.addEventListener('visibilitychange', visibility);
    return () => {
      owner.removeEventListener('visibilitychange', visibility);
      retire();
    };
  }, [props.previews, scopeKey, readAvailable]);
  const current = useRef({ scopeKey, readAvailable });
  useLayoutEffect(() => {
    current.current = { scopeKey, readAvailable };
  });
  // scopeKey contains every read identity and the exact image references.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Repainting a message must not restart the active original.
  const galleryImages = useMemo<readonly ImageGalleryItem[]>(
    () =>
      images?.map((image, index) => ({
        id: String(index),
        name: image.name,
        source: {
          load: (signal: AbortSignal) => {
            const admitted = () =>
              current.current.readAvailable &&
              current.current.scopeKey === scopeKey &&
              !document.hidden;
            return queueRead(props.bridge, async () => {
              signal.throwIfAborted();
              if (!admitted()) throw Error('input_image_read_inactive');
              const { blob } = await readImage(
                { ...props, originalScope, onOriginalScopeRejected },
                index,
                image,
                signal,
                admitted,
              );
              signal.throwIfAborted();
              if (!admitted()) throw Error('input_image_read_inactive');
              return blob;
            });
          },
        },
      })) ?? [],
    [props.bridge, props.previews, scopeKey, originalScope, onOriginalScopeRejected],
  );
  return (
    <>
      <MessageAttachments
        count={(props.message.files?.length ?? 0) + (images?.length ?? 0)}
        className="native-user-images"
      >
        {props.message.files?.map((file, index) => (
          <AttachmentFileCard name={file.name} key={`${index}/${file.uri}`} />
        ))}
        {images?.map((image, index) => (
          <NativeUserImage
            {...props}
            originalScope={originalScope}
            onOriginalScopeRejected={onOriginalScopeRejected}
            image={image}
            index={index}
            onPreview={() => setSelectedId(String(index))}
            key={JSON.stringify([
              props.generation,
              props.message.sessionId,
              index,
              props.message.id,
              image.reference,
            ])}
          />
        ))}
      </MessageAttachments>
      <ImageGallery
        images={galleryImages}
        selectedId={selectedId}
        onSelectedIdChange={setSelectedId}
        scopeKey={scopeKey}
        disabled={!readAvailable}
      />
    </>
  );
}

/** Freeze names only; draft blob URLs remain owned and released by the input draft lifecycle. */
export type NativePendingAttachmentNames = {
  files?: readonly { name: string }[];
  images?: readonly { name: string }[];
};

export function NativePendingAttachments({ files, images }: NativePendingAttachmentNames) {
  return (
    <MessageAttachments count={(files?.length ?? 0) + (images?.length ?? 0)}>
      {files?.map((file, index) => (
        <AttachmentFileCard name={file.name} key={`file:${index}`} />
      ))}
      {images?.map((image, index) => (
        <Attachment
          orientation="vertical"
          className="composer-attachment native-user-image"
          key={`image:${index}`}
        >
          <AttachmentMedia
            variant="image"
            className="composer-attachment-preview"
            role="img"
            aria-label="图片预览等待消息保存"
            aria-busy="true"
          />
          <AttachmentTitle className="composer-attachment-name" title={image.name}>
            {image.name}
          </AttachmentTitle>
        </Attachment>
      ))}
    </MessageAttachments>
  );
}
