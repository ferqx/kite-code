// Isolated test artifact: these controls never enter dev/prod clients.
import { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationCache } from '../../../packages/ui/src/desktop/ConversationCache';
import { ClipboardWriteContext } from '../../../packages/ui/src/desktop/clipboard';
import { MessageContent } from '../../../packages/ui/src/desktop/MessageContent';
import '../src/native-tailwind.css';
import '@kite-ai/ui/desktop/style.css';
import { applyTheme } from '../src/native-theme';

const overview = `# Markdown 内容

[跳到公式](#公式) · 正文脚注[^note]

> [!TIP]
> 图表、公式与代码保留透明底，用细线组织内容。

| 内容 | 状态 |
| --- | --- |
| 图表与数学公式 | 已支持 |
| 代码高亮 | 保留完整源码 |

## 公式

行内公式 $E=mc^2$。

$$
\\int_0^1 x^2\\,dx = \\frac{1}{3}
$$

~~~typescript
const greeting = "你好，世界";
console.log(greeting);
~~~

~~~diff
-const enabled = false;
+const enabled = true;
~~~

[^note]: 脚注与返回链接仅跳转当前消息。
`;
const diagrams: Record<string, string> = {
  流程图: 'graph LR\nA[输入] --> B{校验}\nB -->|通过| C[展示]\nB -->|失败| D[修正源码]',
  时序图:
    'sequenceDiagram\nparticipant U as 用户\nparticipant C as 客户端\nU->>C: 输入 Markdown\nC-->>U: 渲染内容',
  类图: 'classDiagram\nAnimal <|-- Duck\nAnimal : +int age\nAnimal : +move()',
  状态图: 'stateDiagram-v2\n[*] --> Pending\nPending --> Ready\nReady --> [*]',
  'ER 图': 'erDiagram\nUSER ||--o{ MESSAGE : writes\nUSER {\nstring name\n}',
};
function Fixture() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  useLayoutEffect(() => applyTheme(theme), [theme]);
  const [source, setSource] = useState(diagrams.流程图!);
  const [complete, setComplete] = useState(false);
  const [identity, setIdentity] = useState('first');
  const [readActive, setReadActive] = useState(true);
  const [copied, setCopied] = useState('');
  const fence = `\n\n\`\`\`mermaid\n${source}${complete ? '\n```' : ''}`;
  return (
    <div data-theme={theme} style={{ minHeight: '100vh' }}>
      <div className="kite-client" style={{ minHeight: '100vh', display: 'block', padding: 24 }}>
        <nav
          aria-label="隔离测试控制"
          style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 20 }}
        >
          <button type="button" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>
            切换主题
          </button>
          <button type="button" onClick={() => setComplete(true)}>
            完成生成
          </button>
          <button
            type="button"
            onClick={() => {
              setSource('graph TD\nA[');
              setComplete(true);
            }}
          >
            错误源码
          </button>
          <button
            type="button"
            onClick={() => {
              setSource('graph TD\nA[<img src="https://invalid.example/image">]');
              setComplete(true);
            }}
          >
            外部资源
          </button>
          <button
            type="button"
            onClick={() => setIdentity(identity === 'first' ? 'second' : 'first')}
          >
            切换会话
          </button>
          <button type="button" onClick={() => setReadActive(!readActive)}>
            暂停读取
          </button>
          {Object.entries(diagrams).map(([name, value]) => (
            <button
              key={name}
              type="button"
              onClick={() => {
                setSource(value);
                setComplete(true);
              }}
            >
              {name}
            </button>
          ))}
        </nav>
        <output aria-label="复制结果" style={{ whiteSpace: 'pre-wrap' }}>
          {copied}
        </output>
        <main style={{ maxWidth: 780, margin: '0 auto' }}>
          <ConversationCache
            identity={identity}
            loading={false}
            visible
            cache={{ scope: 'fixture', revision: '1', readActive }}
          >
            <ClipboardWriteContext.Provider value={async (text) => setCopied(text)}>
              <MessageContent
                text={
                  identity === 'first'
                    ? overview + fence
                    : '# 另一会话\n\n返回后保留源码展开和阅读位置。'
                }
              />
            </ClipboardWriteContext.Provider>
          </ConversationCache>
        </main>
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
