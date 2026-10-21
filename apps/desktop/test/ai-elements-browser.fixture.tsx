// Explicit isolated browser fixture: no Service, persisted state or user data.
import { useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Conversation } from '../../../packages/ui/src/desktop/Conversation';
import { MessageContent } from '../../../packages/ui/src/desktop/MessageContent';
import { ToolActivity } from '../../../packages/ui/src/desktop/ToolActivity';
import type { Message } from '../../../packages/ui/src/desktop/types';
import '../src/native-tailwind.css';
import '@kite-ai/ui/desktop/style.css';

const source =
  '## Code Block 与工具过程\n\n保留代码原文、工具状态和阅读操作。\n\n```typescript\nconst greeting = "中文 👩‍💻";\nconsole.log(greeting);\n```\n\n```\n没有语言标记的原始文本\nsecond line\n```\n\n```shell\necho "' +
  'long_code_'.repeat(45) +
  '"\n```';
const initial: Message[] = [
  {
    id: 'answer',
    turnId: 'recorded-answer',
    role: 'assistant',
    text: source,
    settled: true,
    finalReply: true,
  },
  {
    id: 'tool:read',
    turnId: 'active-work',
    role: 'tool',
    text: '',
    settled: true,
    toolName: 'read_file',
    target: 'src/main.ts',
    status: 'completed',
    presentation: 'exploration',
    presentationGroupId: 'fixture-batch',
  },
  {
    id: 'tool:search',
    turnId: 'active-work',
    role: 'tool',
    text: '',
    settled: true,
    toolName: 'search_content',
    target: 'CodeBlock',
    status: 'completed',
    presentation: 'exploration',
    presentationGroupId: 'fixture-batch',
  },
  {
    id: 'separator',
    turnId: 'active-work',
    role: 'assistant',
    text: 'Shell 执行输出保留实时跟随与手动阅读位置。',
    settled: true,
  },
  {
    id: 'tool:shell',
    turnId: 'active-work',
    role: 'tool',
    text: '',
    settled: false,
    toolName: 'shell_execute',
    target: 'bun test',
    status: 'running',
    toolProgress: {
      stdout: Array.from({ length: 45 }, (_, i) => `line ${i + 1}: fixture output`).join('\n'),
    },
  },
];
declare global {
  interface Window {
    appendFixture: () => void;
    cancelFixture: () => void;
    thinkFixture: () => void;
    replyFixture: () => void;
    finishTurnFixture: () => void;
    fixtureFileOpens: string[];
  }
}
window.fixtureFileOpens = [];
function App() {
  const [messages, setMessages] = useState(initial);
  const [turnStatus, setTurnStatus] = useState<'running' | 'completed'>('running');
  window.thinkFixture = () =>
    flushSync(() =>
      setMessages((items) => [
        ...items,
        {
          id: 'next-model',
          turnId: 'active-work',
          role: 'thinking',
          text: 'PRIVATE_REASONING',
          settled: false,
        },
      ]),
    );
  window.replyFixture = () =>
    flushSync(() =>
      setMessages((items) =>
        items.map((item) =>
          item.id === 'next-model'
            ? { ...item, role: 'assistant', text: '思考结束后，继续在同一轮次回复。' }
            : item,
        ),
      ),
    );
  window.finishTurnFixture = () => flushSync(() => setTurnStatus('completed'));
  window.appendFixture = () =>
    flushSync(() =>
      setMessages((items) =>
        items.map((item) =>
          item.id === 'tool:shell'
            ? {
                ...item,
                toolProgress: { stdout: `${item.toolProgress?.stdout}\nAPPENDED_FIXTURE_LINE` },
              }
            : item,
        ),
      ),
    );
  window.cancelFixture = () =>
    flushSync(() =>
      setMessages((items) =>
        items.map((item) =>
          item.id === 'tool:shell' ? { ...item, status: 'cancelled', settled: true } : item,
        ),
      ),
    );
  return (
    <div
      className="kite-client"
      style={{
        height: '100vh',
        background: 'var(--background)',
        color: 'var(--foreground)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Conversation
        messages={messages}
        turnActivity={{ turnId: 'active-work', status: turnStatus }}
        loading={false}
        selected
        connected
        saveReading={() => {}}
        openFile={(file) => window.fixtureFileOpens.push(file)}
        renderMessageContent={(message) => <MessageContent text={message.text} />}
        renderToolActivity={(group, state) => (
          <ToolActivity
            messages={group}
            {...state}
            openFile={(file) => window.fixtureFileOpens.push(file)}
            renderChildren={() => null}
          />
        )}
      />
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
