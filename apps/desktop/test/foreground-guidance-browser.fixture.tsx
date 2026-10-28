// Explicit private fixture: production Composer/queue hook with real Main/HTTP/Core behind RPC.
import { MessageContent } from '@kite-ai/ui/desktop';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Composer } from '../../../packages/ui/src/desktop/Composer';
import type { NativeBridge, NativeSelection } from '../src/native-bridge';
import { useNativeInputQueue } from '../src/native-input-queue';
import '../src/native-tailwind.css';
import '@kite-ai/ui/desktop/style.css';

const rpc = async (path: string, body?: unknown) => {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw Error('fixture_rpc_failed');
  return response.json();
};
const bridge: NativeBridge = { request: (request) => rpc('/rpc', request), watch: () => () => {} };
function Fixture() {
  const [facts, setFacts] = useState<{
    selection: NativeSelection;
    messages: { id: string; role: string; content: string }[];
    tools: { id: string; label: string }[];
    requests: number;
    pending: boolean;
    caption?: string;
  }>();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const update = async () => {
      try {
        const next = await rpc('/facts');
        if (active) setFacts(next);
      } catch {
        if (active) setError('读取失败');
      }
    };
    void update();
    const timer = setInterval(update, 200);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const queue = useNativeInputQueue({
    bridge,
    generation: 1,
    selection: facts?.selection,
    historyEpoch: 0,
    available: !!facts && !sending,
    steeringAvailable: !facts?.pending,
    onEditText: (text) => {
      setDraft(text);
      return true;
    },
  });
  return (
    <main className="kite-client" style={{ maxWidth: 900, margin: '30px auto', padding: 24 }}>
      <h1>{facts?.caption ?? '运行中排队与引导 · 私有真实模型验证'}</h1>
      <div role="status">
        模型请求 {facts?.requests ?? 0} ·{' '}
        {facts?.selection.runs.some((run) => run.isActive) ? '运行中' : '已结束'}
      </div>
      <section aria-label="对话记录">
        {facts?.messages.map((message) => (
          <article
            key={message.id}
            data-message-id={message.id}
            style={{ margin: '18px 0', padding: 12, border: '1px solid #8884' }}
          >
            <b>{message.role}</b>
            <MessageContent text={message.content} />
          </article>
        ))}
      </section>
      <section aria-label="前台工具">
        {facts?.tools.map((item) => (
          <div key={item.id}>{item.label}</div>
        ))}
      </section>
      <Composer
        draft={draft}
        onChange={setDraft}
        active={facts?.selection.runs.some((run) => run.isActive) ?? false}
        disabled={sending}
        stopping={false}
        queue={queue.queue}
        sendLabel="排队后续输入"
        onSend={() => {
          if (sending || !draft.trim()) return;
          setSending(true);
          void rpc('/send', { content: draft })
            .then(() => setDraft(''))
            .catch(() => setError('发送失败'))
            .finally(() => setSending(false));
        }}
      />
      <p role="alert">{error || queue.error}</p>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
