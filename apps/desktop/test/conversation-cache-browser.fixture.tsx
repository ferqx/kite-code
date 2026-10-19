// Explicit isolated visual regression; never imported by application entrypoints.

import type { Message, ModelOutputSnapshot } from '@kite-ai/client';
import { useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Conversation } from '../../../packages/ui/src/desktop/Conversation';
import { ConversationCache } from '../../../packages/ui/src/desktop/ConversationCache';
import { MessageContent } from '../../../packages/ui/src/desktop/MessageContent';
import type { Message as DisplayMessage } from '../../../packages/ui/src/desktop/types';
import type { NativeBridge, NativeRequest } from '../src/native-bridge';
import { NativeModelOutputMessage } from '../src/native-model-output-message';
import { NativeUserImages } from '../src/native-user-images';
import '../src/native-tailwind.css';
import '@kite-ai/ui/desktop/style.css';

const encoded =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VQAAAABJRU5ErkJggg==';
const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map((value) => value.toString(16).padStart(2, '0'))
  .join('');
const reference = {
  id: 'picture',
  storeId: 'store',
  sessionId: 'a',
  subjectId: 'owner',
  scope: { kind: 'session' as const, id: 'a' },
  mediaType: 'image/png' as const,
  size: String(bytes.length),
  hash,
};
const imageMessage = {
  id: 'user',
  sessionId: 'a',
  runId: 'run-a',
  role: 'user' as const,
  seq: '1',
  status: 'complete' as const,
  content: '用户问题：阅读附件',
  images: [{ name: 'cached.png', reference }],
};
const metrics = { opens: 0, urls: 0, revoked: 0, copies: 0, fileOpens: 0 };
const create = URL.createObjectURL.bind(URL),
  revoke = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = (blob) => {
  metrics.urls++;
  return create(blob);
};
URL.revokeObjectURL = (url) => {
  metrics.revoked++;
  revoke(url);
};
const bridge = {
  watch: () => () => {},
  async request(input: NativeRequest) {
    if (input.method === 'input.image.open') {
      metrics.opens++;
      return {
        kind: 'input.image.open',
        readId: input.readId,
        size: bytes.length,
        mediaType: 'image/png',
        hash,
      };
    }
    if (input.method === 'input.image.read')
      return {
        kind: 'input.image.chunk',
        readId: input.readId,
        offset: 0,
        nextOffset: bytes.length,
        data: encoded,
        done: true,
      };
    return null;
  },
} as NativeBridge;
const table =
  '\n\n|' +
  Array.from({ length: 40 }, (_, i) => `字段${i}`).join('|') +
  '|\n|' +
  Array.from({ length: 40 }, () => '---').join('|') +
  '|\n|' +
  Array.from({ length: 40 }, (_, i) => `value${i}`).join('|') +
  '|';
const fullText =
  '## 原始回答\n\n这里保留正文、复制反馈、图片与宽表格。[打开文件](src/main.ts)' + table;
const contentBytes = String(new TextEncoder().encode(fullText).length);
const modelMessage: Message = {
  id: 'answer',
  sessionId: 'a',
  runId: 'run-a',
  seq: '2',
  role: 'assistant',
  status: 'complete',
  content: 'PREVIEW',
  outputBody: {
    kind: 'model_output',
    executionId: 'model',
    complete: true,
    contentBytes,
    reasoningBytes: '0',
    toolCallCount: 0,
  },
};
const snapshot: ModelOutputSnapshot = {
  storeId: 'store',
  sessionId: 'a',
  rootSessionId: 'a',
  runId: 'run-a',
  executionId: 'model',
  originCommandId: 'command',
  rootWorkCommandId: 'command',
  rootWorkSeq: '1',
  attempt: 1,
  status: 'succeeded',
  bodyHash: 'a'.repeat(64),
  bodyBytes: '1',
  contentBytes,
  reasoningBytes: '0',
  snapshotCursor: '1',
  output: { content: fullText, reasoning: '', toolCalls: [], complete: true },
};
const a: DisplayMessage[] = [
  { id: 'user', turnId: 'run-a', role: 'user', settled: true, text: imageMessage.content },
  {
    id: 'tool',
    turnId: 'run-a',
    role: 'tool',
    settled: true,
    toolName: 'read_file',
    text: '已读取文件',
    arguments: { path: 'file.ts' },
    status: 'completed',
  },
  {
    id: 'answer',
    turnId: 'run-a',
    role: 'assistant',
    settled: true,
    finalReply: true,
    text: 'PREVIEW',
  },
];
const b: DisplayMessage[] = [
  { id: 'other-user', turnId: 'run-b', role: 'user', settled: true, text: '另一个问题' },
  {
    id: 'other-answer',
    turnId: 'run-b',
    role: 'assistant',
    settled: true,
    finalReply: true,
    text: '另一会话正文',
  },
];
export interface CacheSnapshot {
  opens: number;
  urls: number;
  revoked: number;
  copies: number;
  fileOpens: number;
  imgSame: boolean;
  copySame: boolean;
  replyCopySame: boolean;
  fileSame: boolean;
  summarySame: boolean;
  src?: string;
  decoded: boolean;
  copyOpacity: string | null;
  copyState?: string;
  copyDisabled?: boolean;
  summaryOpacity: string | null;
  summaryBackground: string | null;
  summaryColor: string | null;
  transitions: string | null;
  viewports: number;
}
declare global {
  interface Window {
    switchSession: (id: string, loading?: boolean) => void;
    remember: () => void;
    snapshot: () => CacheSnapshot;
  }
}
let originalImage: HTMLImageElement | null,
  originalCopy: HTMLButtonElement | null,
  originalSummary: HTMLElement | null;
let originalReplyCopy: Element | null, originalFile: Element | null;
function App() {
  const [verifiedCopy, setVerifiedCopy] = useState<string>();
  const messages = a.map((message) =>
    message.id === 'answer' ? { ...message, copyText: verifiedCopy ?? null } : message,
  );
  const [view, setView] = useState({ id: 'a', loading: false, version: 1 });
  window.switchSession = (id: string, loading = false) =>
    flushSync(() => setView((v) => ({ id, loading, version: v.version + 1 })));
  window.remember = () => {
    originalImage = document.querySelector('.native-user-image img');
    originalCopy = document.querySelector('.message.user .message-copy');
    originalSummary = document.querySelector('.agent-turn-summary');
    originalReplyCopy = document.querySelector('.message.assistant .message-copy');
    originalFile = document.querySelector('.file-link');
  };
  window.snapshot = () => {
    const image = document.querySelector<HTMLImageElement>('.native-user-image img');
    const copy = document.querySelector<HTMLButtonElement>('.message.user .message-copy');
    const summary = document.querySelector<HTMLElement>('.agent-turn-summary');
    return {
      ...metrics,
      imgSame: image === originalImage,
      copySame: copy === originalCopy,
      replyCopySame:
        !!originalReplyCopy &&
        document.querySelector('.message.assistant .message-copy') === originalReplyCopy,
      fileSame: !!originalFile && document.querySelector('.file-link') === originalFile,
      summarySame: summary === originalSummary,
      src: image?.src,
      decoded: !!image?.complete && !!image.naturalWidth,
      copyOpacity: copy && getComputedStyle(copy).opacity,
      copyState: copy?.dataset.copyState,
      copyDisabled: copy?.matches(':disabled'),
      summaryOpacity: summary && getComputedStyle(summary).opacity,
      summaryBackground: summary && getComputedStyle(summary).backgroundColor,
      summaryColor: summary && getComputedStyle(summary).color,
      transitions: copy && getComputedStyle(copy).transitionDuration,
      viewports: document.querySelectorAll('.conversation-viewport').length,
    };
  };
  return (
    <div className="kite-client" style={{ height: '100vh' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '180px 1fr',
          height: '100%',
          background: 'var(--background)',
          color: 'var(--foreground)',
        }}
      >
        <nav style={{ padding: 16 }}>
          <button type="button" id="a" onClick={() => window.switchSession('a', true)}>
            会话A
          </button>
          <button type="button" id="b" onClick={() => window.switchSession('b')}>
            会话B
          </button>
        </nav>
        <main style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
          <ConversationCache
            identity={view.id}
            loading={view.loading}
            visible
            cache={{ scope: 'window/store', revision: '0', readActive: !view.loading }}
          >
            <Conversation
              messages={view.id === 'a' ? messages : b}
              loading={false}
              selected
              connected
              saveReading={() => {}}
              writeClipboardText={async () => {
                metrics.copies++;
              }}
              renderMessageContent={(message) =>
                message.id === 'user' ? (
                  <>
                    <p className="user-text">{message.text}</p>
                    <NativeUserImages
                      bridge={bridge}
                      generation={1}
                      viewSelection={view.version}
                      historyEpoch={0}
                      message={imageMessage}
                      readAvailable={!view.loading}
                    />
                  </>
                ) : message.id === 'answer' ? (
                  <NativeModelOutputMessage
                    message={modelMessage}
                    storeId="store"
                    verifiedSnapshot={snapshot}
                    onContent={setVerifiedCopy}
                    renderText={(text) => (
                      <MessageContent
                        text={text}
                        openFile={() => {
                          metrics.fileOpens++;
                        }}
                      />
                    )}
                  />
                ) : (
                  <MessageContent text={message.text} />
                )
              }
            />
          </ConversationCache>
        </main>
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
