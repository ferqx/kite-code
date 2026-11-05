// Isolated test artifact; ordinary Native entrypoints never import these controls or bridge.
import type { Execution, Message } from '@kite-ai/client';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ToolActivity } from '../../../packages/ui/src/desktop/ToolActivity';
import { nativeToolImages } from '../electron/tool-images';
import type { NativeBridge, NativeResult } from '../src/native-bridge';
import { NativeImagePreviews } from '../src/native-image-previews';
import { NativeUserImages } from '../src/native-user-images';
import '../src/native-tailwind.css';
import '@kite-ai/ui/desktop/style.css';

const canvas = new OffscreenCanvas(720, 400),
  context = canvas.getContext('2d')!;
context.fillStyle = 'white';
context.fillRect(0, 0, 720, 400);
context.fillStyle = '#d02020';
context.fillRect(40, 100, 180, 240);
context.fillStyle = '#2040d0';
context.fillRect(400, 220, 180, 120);
context.fillStyle = 'black';
context.font = '48px sans-serif';
context.fillText('KITE IMAGE', 150, 65);
const bytes = new Uint8Array(
  await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer(),
);
const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map((b) => b.toString(16).padStart(2, '0'))
  .join('');
let corrupt = false;
const pending: (() => void)[] = [],
  leases = new Set<string>(),
  events: string[] = [];
const bridge: NativeBridge = {
  watch: () => () => {},
  async request(request): Promise<NativeResult> {
    if (request.method === 'input.image.open') {
      events.push('open');
      leases.add(request.readId);
      await new Promise<void>((resolve) => pending.push(resolve));
      return {
        kind: 'input.image.open',
        readId: request.readId,
        mediaType: 'image/png',
        size: bytes.length,
        hash: corrupt ? 'c'.repeat(64) : hash,
      };
    }
    if (request.method === 'input.image.read') {
      events.push('read');
      const part = bytes.subarray(request.offset, request.offset + 65536);
      return {
        kind: 'input.image.chunk',
        readId: request.readId,
        offset: request.offset,
        nextOffset: request.offset + part.length,
        done: request.offset + part.length === bytes.length,
        data: btoa(String.fromCharCode(...part)),
      };
    }
    if (request.method === 'input.image.close') {
      events.push('close');
      leases.delete(request.readId);
    }
    return null;
  },
};
const previews = new NativeImagePreviews();
const ref = {
  id: 'image',
  scope: { kind: 'execution', id: 'execution' },
  size: String(bytes.length),
  mediaType: 'image/png',
};
const content = JSON.stringify({ path: 'C:/synthetic/scan.png' });
const execution = {
  id: 'execution',
  sessionId: 's',
  originStoreId: 'store',
  definitionId: 'files.view_images',
  definitionVersion: '1',
  status: 'succeeded',
  result: { outcome: 'succeeded', content, artifactRefs: [ref], modelImages: [ref] },
} as unknown as Execution;
const message = {
  id: 'message',
  sessionId: 's',
  seq: '1',
  role: 'tool',
  status: 'complete',
  content,
  sourceIds: ['execution'],
} as Message;
function App() {
  const [stage, setStage] = useState('running'),
    [selection, setSelection] = useState(1);
  const [expanded, setExpanded] = useState<boolean>();
  const complete = stage === 'succeeded' || stage === 'batch';
  const imageCount = stage === 'batch' ? 10 : 1;
  const references = Array.from({ length: imageCount }, (_, i) => ({
    ...ref,
    id: `image-${i + 1}`,
  }));
  const receiptContent =
    imageCount === 1
      ? content
      : JSON.stringify({
          images: references.map((_, i) => ({ path: `C:/synthetic/scan-${i + 1}.png` })),
        });
  const currentMessage = { ...message, content: receiptContent, id: `message-${selection}` };
  const currentExecution = {
    ...execution,
    result: {
      outcome: 'succeeded',
      content: receiptContent,
      artifactRefs: references,
      modelImages: references,
    },
  } as unknown as Execution;
  Object.assign(window, {
    toolImageFixture: {
      show(value = 'succeeded') {
        setStage(value);
        setSelection((old) => old + 1);
        setExpanded(undefined);
      },
      corrupt(value: boolean) {
        corrupt = value;
      },
      release() {
        pending.shift()?.();
      },
      snapshot() {
        return { stage, events: [...events], leases: leases.size, pending: pending.length };
      },
    },
  });
  return (
    <div
      className="kite-client dark"
      data-theme="dark"
      style={{ padding: 32, minHeight: '100vh', background: '#191919', color: '#aaa' }}
    >
      <h2>view_images · 隔离 Native 预览组件</h2>
      <p>工具状态：{stage}</p>
      <div className="conversation-viewport" style={{ height: 360, overflow: 'auto' }}>
        {stage !== 'other-session' ? (
          <ToolActivity
            messages={[
              {
                id: currentMessage.id,
                role: 'tool',
                toolName: 'view_images',
                text: receiptContent,
                status: complete ? 'completed' : stage === 'running' ? 'running' : 'failed',
                settled: stage !== 'running',
                toolImageCount: complete ? imageCount : 0,
              },
            ]}
            expanded={expanded}
            onToggle={setExpanded}
            renderChildren={() => null}
            renderImages={() =>
              complete ? (
                <NativeUserImages
                  bridge={bridge}
                  previews={previews}
                  generation={1}
                  viewSelection={selection}
                  historyEpoch={0}
                  message={currentMessage}
                  readAvailable
                  images={nativeToolImages(currentExecution)}
                />
              ) : null
            }
          />
        ) : null}
      </div>
    </div>
  );
}
declare global {
  interface Window {
    toolImageFixture: {
      show(value?: string): void;
      corrupt(value: boolean): void;
      release(): void;
      snapshot(): { stage: string; events: string[]; leases: number; pending: number };
    };
  }
}
createRoot(document.getElementById('root')!).render(<App />);
