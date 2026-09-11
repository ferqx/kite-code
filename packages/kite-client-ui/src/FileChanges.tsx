import type { Message } from './types';
import { Button } from './ui';

export function FileChanges({
  messages,
  openFile,
}: {
  messages: readonly Message[];
  openFile?: (path: string) => void;
}) {
  return (
    <div className="results">
      <p>{messages.length} 次文件操作</p>
      {!messages.length && <p>当前会话还没有已确认的文件工具变更。</p>}
      {messages.map((message) => (
        <details className="file-change" key={message.id}>
          <summary title={message.changedFile}>
            {message.changedFile || '历史记录未提供文件路径'}
          </summary>
          {message.changedFile && openFile && (
            <Button className="file-link" onClick={() => openFile(message.changedFile!)}>
              {message.changedFile}
            </Button>
          )}
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
        </details>
      ))}
      <details className="change-scope">
        <summary>记录范围</summary>
        <p>
          仅展示成功文件工具保存的差异或写入内容，可能截断。多次修改按操作保留；这不是当前 Git
          diff，也不代表 Agent 的完整贡献。
        </p>
        <p>
          Shell、MCP
          等没有逐文件记录的修改不在此列表中；空列表不代表磁盘没有变化。编辑器打开文件的当前内容。
        </p>
      </details>
    </div>
  );
}
