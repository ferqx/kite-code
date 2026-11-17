// Explicit isolated acceptance artifact, never imported by a normal client.
import type { Message } from '@kite-ai/client';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Composer } from '../../../packages/ui/src/desktop/Composer';
import type { NativeBridge, NativeResult } from '../src/native-bridge';
import { NativeImageGalleryProvider } from '../src/native-image-gallery';
import { NativeImagePreviews } from '../src/native-image-previews';
import { useNativeInputImages } from '../src/native-input-images';
import { NativeUserImages } from '../src/native-user-images';
import '../src/native-tailwind.css';
import '@kite-ai/ui/desktop/style.css';

export interface ImageDisplayFixture {
  add(): Promise<void>;
  mode(value: string): void;
  scope(value: string): void;
  available(value: boolean): void;
  hold(value: boolean): void;
  snapshot(): {
    mode: string;
    scope: string;
    draft: string;
    uploadHashes: string[];
    sourceHashes: string[];
    leases: number;
    drafts: { name: string; error?: string; loading?: boolean; previewError?: string }[];
  };
}
declare global {
  interface Window {
    imageDisplayFixture: ImageDisplayFixture;
  }
}

type Source = { name: string; mediaType: string; hash: string; size: number };
const sources: Source[] = await (await fetch('/sources')).json();
const bytes = await Promise.all(
  sources.map(async (_, i) => new Uint8Array(await (await fetch(`/source/${i}`)).arrayBuffer())),
);
const files = sources.map(
  (source, i) => new File([bytes[i]!], source.name, { type: source.mediaType }),
);
const leases = new Map<string, number>();
const uploads = new Map<string, Uint8Array[]>();
const uploadHashes: string[] = [];
const hash = async (value: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(value)))]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
let held = false;
const releases: (() => void)[] = [];
const bridge: NativeBridge = {
  ...window.kiteNative!,
  watch: () => () => {},
  async request(request): Promise<NativeResult> {
    if (request.method === 'input.images.begin') {
      uploads.set(request.id, []);
      return null;
    }
    if (request.method === 'input.images.append') {
      uploads.get(request.id)!.push(Uint8Array.from(atob(request.data), (c) => c.charCodeAt(0)));
      return null;
    }
    if (request.method === 'input.images.finish') {
      const parts = uploads.get(request.id)!;
      const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let offset = 0;
      for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
      }
      uploadHashes.push(await hash(result));
      uploads.delete(request.id);
      return null;
    }
    if (request.method === 'input.image.open') {
      leases.set(request.readId, request.index);
      if (held) await new Promise<void>((resolve) => releases.push(resolve));
      const source = sources[request.index]!;
      return { kind: 'input.image.open', readId: request.readId, ...source };
    }
    if (request.method === 'input.image.read') {
      const value = bytes[leases.get(request.readId)!]!;
      const part = value.subarray(request.offset, request.offset + 65536);
      return {
        kind: 'input.image.chunk',
        readId: request.readId,
        offset: request.offset,
        nextOffset: request.offset + part.length,
        done: request.offset + part.length === value.length,
        data: btoa(String.fromCharCode(...part)),
      };
    }
    if (request.method === 'input.image.close') leases.delete(request.readId);
    return null;
  },
};
const previews = new NativeImagePreviews();
const images = sources.map((source, i) => ({
  name: source.name,
  reference: {
    id: `image-${i}`,
    storeId: 'store',
    sessionId: 's',
    subjectId: 'owner',
    scope: { kind: 'session', id: 's' },
    mediaType: source.mediaType,
    size: String(source.size),
    hash: source.hash,
  },
}));
function App() {
  const attachments = useNativeInputImages(bridge, 1, 'store');
  const [mode, setMode] = useState('draft'),
    [scope, setScope] = useState('s'),
    [available, setAvailable] = useState(true);
  const [draft, setDraft] = useState('预览不能修改原图或这段正文。');
  Object.assign(window, {
    imageDisplayFixture: {
      async add() {
        await attachments.add('draft', files);
      },
      mode: setMode,
      scope: setScope,
      available: setAvailable,
      hold(value: boolean) {
        held = value;
        if (!value) for (const release of releases.splice(0)) release();
      },
      snapshot() {
        return {
          mode,
          scope,
          draft,
          uploadHashes,
          sourceHashes: sources.map((v) => v.hash),
          leases: leases.size,
          drafts: attachments.get('draft').map((v) => ({
            name: v.name,
            error: v.error,
            loading: v.loading,
            previewError: v.previewError,
          })),
        };
      },
    } satisfies ImageDisplayFixture,
  });
  return (
    <div className="kite-client" style={{ padding: 24, height: '100vh', overflow: 'auto' }}>
      <h2>图片显示副本 · 真实 Electron 验收</h2>
      <p>草稿 / 已发消息 / Agent 工具图 · PNG / JPEG / WebP / GIF</p>
      {mode === 'draft' ? (
        <Composer
          scopeKey={scope}
          draft={draft}
          onChange={setDraft}
          disabled={false}
          active={false}
          stopping={false}
          images={attachments.get('draft')}
          onRemoveImage={(id) => attachments.removeIds([id])}
        />
      ) : (
        <div data-source={mode}>
          <NativeUserImages
            bridge={bridge}
            previews={previews}
            generation={1}
            viewSelection={1}
            historyEpoch={0}
            readAvailable={available}
            images={
              mode === 'tool'
                ? images.map(({ name, reference }) => ({
                    name,
                    reference: {
                      hash: reference.hash,
                      mediaType: reference.mediaType,
                      size: reference.size,
                    },
                  }))
                : undefined
            }
            message={
              {
                id: `${mode}-${scope}`,
                sessionId: 's',
                seq: '1',
                runId: null,
                role: mode === 'user' ? 'user' : 'tool',
                status: 'complete',
                content: '',
                files: [],
                images,
              } as unknown as Message
            }
          />
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <NativeImageGalleryProvider>
    <App />
  </NativeImageGalleryProvider>,
);
