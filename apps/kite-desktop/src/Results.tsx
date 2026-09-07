import { useState } from 'react';
import type { DesktopClient, DesktopView } from './client';

export function Results({
  client,
  view,
  busy,
  act,
}: {
  client: DesktopClient;
  view: DesktopView;
  busy: boolean;
  act: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [editor, setEditor] = useState<'vscode' | 'zed' | 'textedit'>('vscode');
  const changes = view.messages.filter((message) => message.changeConfirmed);
  return (
    <details className="results">
      <summary>会话变更记录 · {changes.length} 次文件操作</summary>
      <p>
        展示文件工具成功操作时保存的差异或写入内容，不是当前工作区 Git
        diff。多次编辑按操作顺序保留，已有用户修改不作为 Agent 的贡献。
      </p>
      <p>
        输出有大小限制，可能截断。Shell、MCP
        等工具未提供逐文件记录的修改不在此列表中；空列表不代表磁盘没有变化。外部编辑器打开的是文件当前内容。
      </p>
      <label>
        外部编辑器{' '}
        <select
          aria-label="外部编辑器"
          value={editor}
          onChange={(event) => setEditor(event.target.value as typeof editor)}
        >
          <option value="vscode">Visual Studio Code</option>
          <option value="zed">Zed</option>
          <option value="textedit">TextEdit</option>
        </select>
      </label>
      {changes.map((message) => (
        <section className="file-change" key={message.id}>
          <div className="change-header">
            <strong>{message.changedFile || '历史记录未提供文件路径'}</strong>
            <button
              type="button"
              disabled={busy || !view.connected || !message.changedFile}
              onClick={() => void act(() => client.openFile(message.changedFile!, editor))}
            >
              在编辑器打开
            </button>
          </div>
          {!message.toolResult ? (
            <p>尚无可读的终态输出，请检查工具过程。</p>
          ) : (
            <pre className="diff-output">
              {(message.toolResult.stdout || message.toolResult.stderr || '工具没有返回可读差异。')
                .split('\n')
                .map((line, index) => (
                  <span
                    key={`${index}:${line}`}
                    className={
                      /^\s*\d+ \+/.test(line)
                        ? 'diff-added'
                        : /^\s*\d+ -/.test(line)
                          ? 'diff-removed'
                          : undefined
                    }
                  >
                    {line}
                    {'\n'}
                  </span>
                ))}
            </pre>
          )}
        </section>
      ))}
    </details>
  );
}
