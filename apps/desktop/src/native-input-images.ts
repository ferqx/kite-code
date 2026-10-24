import { useEffect, useLayoutEffect, useMemo, useReducer, useRef } from 'react';
import {
  encodeInputImageChunk,
  hashInputImage,
  inputImageBytes,
  inputImageChunkBytes,
  inputImageTotalBytes,
  readInputFileChunk,
} from './input-image-encoding';
import { inputImageCount, inputImageWindowCount } from './input-images-bridge';
import type { NativeBridge } from './native-bridge';
import { NativeImagePreviews } from './native-image-previews';

type ImageDraft = {
  id: string;
  name: string;
  url: string;
  generation: number;
  size: number;
  abort: AbortController;
  loading?: boolean;
  error?: string;
  previewError?: string;
};
const mediaTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
type FileDraft = { id: string; name: string; uri: string; generation: number; prepared?: boolean };
function attachmentHostOutdated(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return code === 'invalid_native_request' || code === 'native_host_operation_unavailable';
}

/** Draft bytes belong to their original conversation, independent of the currently read page. */
export function useNativeInputImages(
  bridge: NativeBridge | undefined,
  generation: number | undefined,
  storeId: string | undefined,
) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: Derived content cannot cross a connection, generation or Store boundary.
  const previews = useMemo(() => new NativeImagePreviews(), [bridge, generation, storeId]);
  const drafts = useRef(new Map<string, (ImageDraft | FileDraft)[]>());
  const preparation = useRef(Promise.resolve());
  const preparingFiles = useRef(new Set<AbortController>());
  const preparedFiles = useRef(new Set<string>());
  const fileHandoffs = useRef(new Map<string, () => void>());
  const [, redraw] = useReducer((value) => value + 1, 0);
  const current = useRef({ bridge, generation, storeId });
  useLayoutEffect(() => {
    current.current = { bridge, generation, storeId };
  });
  useEffect(() => {
    return () => {
      previews.clear();
      for (const controller of preparingFiles.current) controller.abort();
      preparingFiles.current.clear();
      if (bridge && generation)
        for (const id of preparedFiles.current)
          void bridge.request({ method: 'input.files.release', generation, id }).catch(() => {});
      preparedFiles.current.clear();
      for (const images of drafts.current.values())
        for (const image of images) {
          if (!('url' in image)) continue;
          image.abort.abort();
          if (image.url) URL.revokeObjectURL(image.url);
          if (bridge && generation && storeId)
            void bridge
              .request({ method: 'input.images.release', generation, id: image.id })
              .catch(() => {});
        }
      drafts.current.clear();
    };
  }, [bridge, generation, storeId, previews]);
  function all(key: string) {
    return drafts.current.get(key)?.filter((image) => image.generation === generation) ?? [];
  }
  function get(key: string) {
    return all(key).filter((item): item is ImageDraft => 'url' in item);
  }
  function files(key: string) {
    return all(key).filter((item): item is FileDraft => 'uri' in item);
  }
  function addFiles(
    key: string,
    selected: readonly { name: string; uri: string; id?: string; prepared?: boolean }[],
  ) {
    if (
      !bridge ||
      !generation ||
      !storeId ||
      current.current.bridge !== bridge ||
      current.current.generation !== generation ||
      current.current.storeId !== storeId
    )
      return;
    const uris = new Set(files(key).map((file) => file.uri));
    drafts.current.set(key, [
      ...all(key),
      ...selected
        .filter((file) => {
          if (uris.has(file.uri)) {
            if (file.prepared && file.id) {
              fileHandoffs.current.get(file.id)?.();
              preparedFiles.current.delete(file.id);
              void bridge
                .request({ method: 'input.files.release', generation, id: file.id })
                .catch(() => {});
            }
            return false;
          }
          uris.add(file.uri);
          return true;
        })
        .map((file) => {
          if (file.prepared && file.id) fileHandoffs.current.get(file.id)?.();
          return { ...file, id: file.id ?? crypto.randomUUID(), generation };
        }),
    ]);
    redraw();
  }
  function removeIds(ids: readonly string[]) {
    const selected = new Set(ids);
    for (const [key, images] of drafts.current) {
      for (const image of images.filter((image) => selected.has(image.id))) {
        if (!('url' in image)) {
          preparedFiles.current.delete(image.id);
          if (image.prepared && bridge && generation)
            void bridge
              .request({ method: 'input.files.release', generation, id: image.id })
              .catch(() => {});
          continue;
        }
        image.abort.abort();
        if (image.url) URL.revokeObjectURL(image.url);
        if (bridge && generation)
          void bridge
            .request({ method: 'input.images.release', generation, id: image.id })
            .catch(() => {});
      }
      drafts.current.set(
        key,
        images.filter((image) => !selected.has(image.id)),
      );
    }
    redraw();
  }
  function move(from: string, to: string) {
    if (from === to || !drafts.current.has(from)) return;
    drafts.current.set(to, [...all(to), ...all(from)]);
    drafts.current.delete(from);
    redraw();
  }
  async function add(key: string, files: readonly File[]) {
    if (!bridge || !generation || !storeId) return;
    if (get(key).length + files.length > inputImageCount)
      throw Object.assign(Error('input_image_count_limit'), { code: 'input_image_count_limit' });
    if (
      [...drafts.current.keys()].reduce((count, scope) => count + get(scope).length, 0) +
        files.length >
      inputImageWindowCount
    )
      throw Object.assign(Error('input_image_window_count_limit'), {
        code: 'input_image_window_count_limit',
      });
    const original = { bridge, generation, storeId };
    const pending: Promise<void>[] = [];
    let reserved = [...drafts.current.values()]
      .flat()
      .filter((image): image is ImageDraft => image.generation === generation && 'url' in image)
      .reduce((size, image) => size + image.size, 0);
    for (const file of files) {
      if (
        current.current.bridge !== bridge ||
        current.current.generation !== generation ||
        current.current.storeId !== storeId
      )
        return;
      const id = crypto.randomUUID();
      const mediaType =
        file.type ||
        (
          {
            png: 'image/png',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            webp: 'image/webp',
            gif: 'image/gif',
          } as Record<string, string>
        )[file.name.split('.').at(-1)?.toLowerCase() ?? ''] ||
        '';
      const item: ImageDraft = {
        id,
        name: file.name || '粘贴的图片',
        generation,
        size: 0,
        abort: new AbortController(),
        url: '',
        loading: true,
      };
      drafts.current.set(key, [...all(key), item]);
      const error = !mediaTypes.includes(mediaType as (typeof mediaTypes)[number])
        ? '图片支持 PNG、JPEG、WebP、GIF，请转换格式后重试。'
        : !file.size || file.size > inputImageBytes
          ? '图片为空或超过 16 MiB，请缩小后重试。'
          : reserved + file.size > inputImageTotalBytes
            ? '待发送图片总量超过 64 MiB，请移除部分图片后重试。'
            : undefined;
      if (error) {
        item.loading = false;
        item.error = error;
        continue;
      }
      item.size = file.size;
      reserved += file.size;
      const alive = () =>
        !item.abort.signal.aborted &&
        current.current.bridge === original.bridge &&
        current.current.generation === generation &&
        current.current.storeId === storeId &&
        get(key).includes(item);
      const prepare = async () => {
        if (!alive()) return;
        try {
          const hash = await hashInputImage(file, item.abort.signal);
          if (!alive()) return;
          try {
            const preview = await previews.prepare(
              file.slice(0, file.size, mediaType),
              hash,
              item.abort.signal,
            );
            if (!alive()) return;
            item.url = URL.createObjectURL(preview.blob);
          } catch {
            if (!alive()) return;
            // Preview failure does not change or prevent the original image submission.
            item.previewError = '预览不可用';
          }
          redraw();
          await bridge.request({
            method: 'input.images.begin',
            generation,
            id,
            name: item.name,
            mediaType: mediaType as (typeof mediaTypes)[number],
            size: file.size,
            hash,
          });
          for (let offset = 0; offset < file.size; offset += inputImageChunkBytes) {
            if (!alive()) throw Error('changed');
            const data = await encodeInputImageChunk(
              file.slice(offset, offset + inputImageChunkBytes),
              item.abort.signal,
            );
            if (!alive()) throw Error('changed');
            await bridge.request({ method: 'input.images.append', generation, id, offset, data });
          }
          if (!alive()) throw Error('changed');
          await bridge.request({ method: 'input.images.finish', generation, id });
          item.loading = false;
        } catch (error) {
          void bridge.request({ method: 'input.images.release', generation, id }).catch(() => {});
          if (!alive()) return;
          item.loading = false;
          if (item.url) URL.revokeObjectURL(item.url);
          item.url = '';
          item.size = 0;
          item.error = attachmentHostOutdated(error)
            ? '图片附件功能尚未加载，请完全退出并重新打开应用。'
            : '图片准备失败，请移除后重新添加。';
        }
        if (alive()) redraw();
      };
      const task = preparation.current.then(prepare);
      preparation.current = task.catch(() => {});
      pending.push(task);
    }
    redraw();
    await Promise.all(pending);
  }
  async function fileReferences(selected: readonly File[], signal?: AbortSignal) {
    if (!bridge?.fileReferences)
      throw Object.assign(Error('file_picker_restart_required'), {
        code: 'file_picker_restart_required',
      });
    if (!generation || !storeId) throw Error('file_reference_unavailable');
    const references = bridge.fileReferences(selected);
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    preparingFiles.current.add(controller);
    const ids: string[] = [];
    const unclaimed = new Set<string>();
    let ready = false;
    const cleanup = () => {
      signal?.removeEventListener('abort', abort);
      preparingFiles.current.delete(controller);
    };
    controller.signal.addEventListener(
      'abort',
      () => {
        if (!ready) return;
        for (const id of unclaimed) {
          fileHandoffs.current.delete(id);
          preparedFiles.current.delete(id);
          void bridge.request({ method: 'input.files.release', generation, id }).catch(() => {});
        }
        unclaimed.clear();
        cleanup();
      },
      { once: true },
    );
    const prepare = async () => {
      const result: { name: string; uri: string; id: string; prepared: true }[] = [];
      const check = () => {
        controller.signal.throwIfAborted();
        if (
          current.current.bridge !== bridge ||
          current.current.generation !== generation ||
          current.current.storeId !== storeId
        )
          throw Error('file_preparation_cancelled');
      };
      try {
        for (const [index, file] of selected.entries()) {
          check();
          if (file.size > 256 * 1024 * 1024) throw Error('input_file_too_large');
          const id = crypto.randomUUID();
          ids.push(id);
          preparedFiles.current.add(id);
          await bridge.request({
            method: 'input.files.begin',
            generation,
            id,
            name: file.name,
            mediaType:
              file.type ||
              (file.name.toLowerCase().endsWith('.pdf')
                ? 'application/pdf'
                : 'application/octet-stream'),
            size: file.size,
          });
          for (let offset = 0; offset < file.size; offset += 65536) {
            check();
            const data = await readInputFileChunk(
              file.slice(offset, offset + 65536),
              controller.signal,
            );
            await bridge.request({ method: 'input.files.append', generation, id, offset, data });
          }
          check();
          await bridge.request({ method: 'input.files.finish', generation, id });
          check();
          result.push({ ...references[index]!, id, prepared: true });
        }
        check();
        ready = true;
        for (const id of ids) {
          unclaimed.add(id);
          fileHandoffs.current.set(id, () => {
            fileHandoffs.current.delete(id);
            unclaimed.delete(id);
            if (!unclaimed.size) cleanup();
          });
        }
        if (!unclaimed.size) cleanup();
        return result;
      } catch (error) {
        for (const id of ids) preparedFiles.current.delete(id);
        await Promise.allSettled(
          ids.map((id) => bridge.request({ method: 'input.files.release', generation, id })),
        );
        throw error;
      } finally {
        if (!ready) cleanup();
      }
    };
    const task = preparation.current.then(prepare);
    preparation.current = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  return { get, files, add, addFiles, removeIds, move, fileReferences, previews };
}
