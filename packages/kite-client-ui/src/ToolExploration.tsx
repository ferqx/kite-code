import { statusLabel } from './status';
import type { Message } from './types';
import { Button } from './ui';

const explorationNames = new Set([
  'read_file',
  'search_content',
  'search_files',
  'read_mcp_resource',
]);

/** Only explicit built-in identities qualify; shell and MCP tool labels are not permissions. */
export function isExploration(message: Message) {
  return message.role === 'tool' && !!message.toolName && explorationNames.has(message.toolName);
}

export function ToolExploration({
  messages,
  expanded,
  onToggle,
  openFile,
}: {
  messages: readonly Message[];
  expanded?: boolean;
  onToggle: (open: boolean) => void;
  openFile?: (path: string) => void;
}) {
  const active = messages.some((message) => !message.settled);
  const open = expanded ?? active;
  const reads = messages.filter((message) => message.toolName === 'read_file');
  const searches = messages.filter(
    (message) => message.toolName === 'search_content' || message.toolName === 'search_files',
  );
  const resources = messages.length - reads.length - searches.length;
  const unsuccessful = messages.filter(
    (message) => message.settled && message.status !== 'completed',
  ).length;
  const summary = [
    reads.length && `读取 ${reads.length} 次`,
    searches.length && `搜索 ${searches.length} 次`,
    resources && `读取 ${resources} 项资源`,
  ]
    .filter(Boolean)
    .join(' · ');
  const visible = active && expanded === undefined ? messages.slice(-5) : messages;
  return (
    <article className="message exploration" aria-label="只读探索">
      <Button
        className="ghost exploration-summary"
        aria-expanded={open}
        onClick={() => onToggle(!open)}
      >
        <span aria-hidden="true">{open ? '⌄' : '›'}</span>
        <span>{summary}</span>
        <span>{active ? '进行中' : unsuccessful ? `${unsuccessful} 项未成功` : '已完成'}</span>
      </Button>
      {open && (
        <div className="exploration-steps">
          {visible.length < messages.length && (
            <Button className="ghost" onClick={() => onToggle(true)}>
              展开全部 {messages.length} 项记录
            </Button>
          )}
          {visible.map((message) => {
            const path =
              message.toolName === 'read_file' && typeof message.arguments?.path === 'string'
                ? message.arguments.path
                : undefined;
            const target =
              path ??
              (typeof message.arguments?.pattern === 'string'
                ? message.arguments.pattern
                : message.title || message.toolName);
            return (
              <div className="exploration-step" key={message.id}>
                <div className="exploration-target">
                  {path && openFile ? (
                    <Button className="file-link" onClick={() => openFile(path)}>
                      {path}
                    </Button>
                  ) : (
                    <span>{target}</span>
                  )}
                  <small>{message.status ? statusLabel(message.status) : '状态未提供'}</small>
                </div>
                <details>
                  <summary>执行明细</summary>
                  {message.arguments && (
                    <pre className="tool-arguments">
                      {JSON.stringify(message.arguments, null, 2)}
                    </pre>
                  )}
                  <pre className="tool-output">
                    {message.text || (message.settled ? '无输出' : '正在执行工具…')}
                  </pre>
                </details>
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
}
