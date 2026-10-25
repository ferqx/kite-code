// Isolated test artifact: these controls never enter dev/prod clients.
import { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationCache } from '../../../packages/ui/src/desktop/ConversationCache';
import { ClipboardWriteContext } from '../../../packages/ui/src/desktop/clipboard';
import { MessageContent } from '../../../packages/ui/src/desktop/MessageContent';
import { PromptEditor } from '../../../packages/ui/src/desktop/PromptEditor';
import '../src/native-tailwind.css';
import '@kite-ai/ui/desktop/style.css';
import { applyTheme } from '../src/native-theme';

const overview = `# Markdown 内容

[跳到公式](#公式) · 正文脚注[^note]

正文中的 \`sessionId\`、\`bun test ./packages/ui/test/markdown.test.tsx\` 与[外部文档](https://example.com/markdown)各自保持清楚的视觉识别。

> 普通引用保留左侧竖线，长段中文在深浅主题中都应清楚可读。

> [!NOTE]
> 说明文字使用轻微底色，与普通引用区分。

> [!TIP]
> 代码使用独立表面；图表和公式保留透明展示。

> [!IMPORTANT]
> 重要信息有自己的图标与标题，正文保留原文。

> [!WARNING]
> 警告使用克制的提示色，文字仍然容易阅读。

> [!CAUTION]
> 注意信息以图标、文字和底色共同表达。

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
const editorSource =
  '输入中的 `sessionId` 与[外部文档](https://example.com/markdown)。\n\n> 编辑引用保持可读。\n\n```typescript\nconst draft = "编辑原文";\n```';
const streamingSamples = [
  '',
  '## 流式样式预览\n\n已经显示的文字与 `sessionId` 保持稳定。',
  '## 流式样式预览\n\n已经显示的文字与 `sessionId` 保持稳定。继续追加中文与[文档](https://example.com/stream)。\n\n> [!TIP]\n> 新追加的提示保留自己的底色和图标。\n\n```typescript\nconst streamed = "追加中";',
  '## 流式样式预览\n\n已经显示的文字与 `sessionId` 保持稳定。继续追加中文与[文档](https://example.com/stream)。\n\n> [!TIP]\n> 新追加的提示保留自己的底色和图标。\n\n```typescript\nconst streamed = "追加中";\nconsole.log(streamed);\n```\n\n生成完成，旧文字与代码表面保持。',
];
function Fixture() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  useLayoutEffect(() => applyTheme(theme), [theme]);
  const [source, setSource] = useState(diagrams.流程图!);
  const [complete, setComplete] = useState(false);
  const [identity, setIdentity] = useState('first');
  const [readActive, setReadActive] = useState(true);
  const [copied, setCopied] = useState('');
  const [draft, setDraft] = useState(editorSource);
  const [streamStep, setStreamStep] = useState(0);
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
          <button type="button" onClick={() => setStreamStep(1)}>
            开始流式预览
          </button>
          <button type="button" onClick={() => setStreamStep(2)} disabled={streamStep !== 1}>
            追加流式预览
          </button>
          <button type="button" onClick={() => setStreamStep(3)} disabled={streamStep !== 2}>
            完成流式预览
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
          <section aria-label="输入样式预览" style={{ marginTop: 32 }}>
            <h2>输入样式预览</h2>
            <PromptEditor
              value={draft}
              scopeKey="markdown-style-fixture"
              label="Markdown 样式输入"
              disabled={false}
              onChange={setDraft}
              onSend={() => {}}
            />
          </section>
          {streamStep > 0 && (
            <section aria-label="流式样式预览" style={{ marginTop: 32 }}>
              <ClipboardWriteContext.Provider value={async (text) => setCopied(text)}>
                <MessageContent text={streamingSamples[streamStep]!} streaming={streamStep < 3} />
              </ClipboardWriteContext.Provider>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
