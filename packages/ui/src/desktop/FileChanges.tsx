import { type CSSProperties, type ReactNode, useId, useMemo, useRef, useState } from 'react';
import { ScrollArea } from './components/ui/scroll-area';
import {
  clipDiffLine,
  type DiffLine,
  type DiffModel,
  fileDiffRows,
  parseFileDiff,
} from './file-diff-model';
import type { Message } from './types';
import { Button } from './ui';

export function FileChanges({
  messages,
  openFile,
  renderDetail,
  loading,
}: {
  messages: readonly Message[];
  openFile?: (path: string) => void;
  renderDetail?: (message: Message) => ReactNode;
  loading?: boolean;
}) {
  const [expanded, setExpanded] = useState(new Set<string>());
  return (
    <div className="results" aria-busy={loading || undefined}>
      <p>{messages.length} 次文件操作</p>
      {!loading && !messages.length && <p>当前会话还没有已确认的文件工具变更。</p>}
      {messages.map((message) => (
        <details
          className="file-change"
          key={message.id}
          onToggle={
            renderDetail
              ? (event) => {
                  const open = event.currentTarget.open;
                  setExpanded((previous) => {
                    const next = new Set(previous);
                    if (open) next.add(message.id);
                    else next.delete(message.id);
                    return next;
                  });
                }
              : undefined
          }
        >
          <summary title={message.changedFile}>
            {message.changedFile || '历史记录未提供文件路径'}
          </summary>
          {message.changedFile && openFile && (
            <Button className="file-link" onClick={() => openFile(message.changedFile!)}>
              {message.changedFile}
            </Button>
          )}
          {renderDetail ? (
            expanded.has(message.id) && renderDetail(message)
          ) : !message.toolResult ? (
            <p>尚无可读的终态输出，请检查工具过程。</p>
          ) : (
            <FileDiff message={message} />
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

/** Render host-verified text only. Identity changes discard the old reader and folding state. */
export function FileDiff({
  message,
  path = message.changedFile,
  scope = 'operation',
  layout,
  onLayoutChange,
}: {
  message: Message;
  path?: string;
  scope?: 'operation' | 'workspace';
  layout?: 'split' | 'unified';
  onLayoutChange?: (layout: 'split' | 'unified') => void;
}) {
  const source =
    message.toolResult?.stdout || message.toolResult?.stderr || '工具没有返回可读差异。';
  const model = useMemo(() => parseFileDiff(source, path), [source, path]);
  return (
    <DiffReader
      key={`${message.id}:${scope}:${path ?? ''}`}
      model={model}
      path={path}
      scope={scope}
      layout={layout}
      onLayoutChange={onLayoutChange}
    />
  );
}

function DiffCode({ line }: { line: DiffLine }) {
  return (
    <span className="file-diff-code">
      {line.tokens.map((token, index) =>
        token.kind ? (
          <span key={index} className={`file-diff-token-${token.kind}`}>
            {token.text}
          </span>
        ) : (
          token.text
        ),
      )}
    </span>
  );
}

function DiffCell({
  line,
  change,
  side,
  showNumber = true,
}: {
  line?: DiffLine;
  change: boolean;
  side: 'before' | 'after';
  showNumber?: boolean;
}) {
  if (!line) return <div className="file-diff-cell file-diff-empty" aria-hidden="true" />;
  const marker = !change ? ' ' : side === 'before' ? '-' : '+';
  return (
    <div
      className={`file-diff-cell${change ? (side === 'before' ? ' diff-removed' : ' diff-added') : ''}`}
    >
      <span
        className="file-diff-number"
        title={line.number === undefined ? '原记录未提供此侧行号' : undefined}
      >
        {showNumber ? (line.number ?? '') : ''}
      </span>{' '}
      <span
        className="file-diff-sign"
        role="img"
        aria-label={!change ? '未变更行' : side === 'before' ? '删除行' : '新增行'}
      >
        {marker}
      </span>
      <DiffCode line={line} />
    </div>
  );
}

function DiffReader({
  model,
  path,
  scope,
  layout: controlledLayout,
  onLayoutChange,
}: {
  model: DiffModel;
  path?: string;
  scope: 'operation' | 'workspace';
  layout?: 'split' | 'unified';
  onLayoutChange?: (layout: 'split' | 'unified') => void;
}) {
  const [localLayout, setLayout] = useState<'split' | 'unified'>('split');
  const layout = controlledLayout ?? localLayout;
  const [folds, setFolds] = useState<{ model: DiffModel; expanded: Set<number> }>({
    model,
    expanded: new Set(),
  });
  // Clear changed body state during render, not in an effect after an old frame was shown.
  if (folds.model !== model) setFolds({ model, expanded: new Set() });
  const expanded = folds.model === model ? folds.expanded : new Set<number>();
  const rows = useMemo(() => fileDiffRows(model[layout], expanded), [model, layout, expanded]);
  const viewport = useRef<HTMLDivElement>(null);
  const bodyId = useId();
  const hasContext = model.split.some(
    (row, index, all) =>
      row.kind === 'context' &&
      all[index + 8]?.kind === 'context' &&
      all.slice(index, index + 9).every((next) => next.kind === 'context'),
  );
  const metrics = useMemo(() => {
    let max = 24;
    let metadata = 0;
    let digits = 4;
    const width = (text: string) => {
      let columns = 0;
      // Conservative monospace width: keep CJK/emoji inside its own half too.
      for (const char of text) columns += char === '\t' ? 4 : char.codePointAt(0)! > 127 ? 2 : 1;
      return columns;
    };
    for (const row of model[layout]) {
      if (row.kind !== 'context' && row.kind !== 'change') {
        metadata = Math.max(metadata, width(row.text));
        continue;
      }
      for (const line of [row.before, row.after]) {
        if (!line) continue;
        max = Math.max(max, width(line.text));
        digits = Math.max(digits, String(line.number ?? '').length);
      }
    }
    const gutter = digits + 2;
    return {
      gutter,
      columns: Math.max(
        metadata + 2,
        layout === 'split' ? (max + gutter + 4) * 2 : max + gutter * 2 + 4,
      ),
    };
  }, [model, layout]);
  const chooseLayout = (next: 'split' | 'unified') => {
    if (next === layout) return;
    setLayout(next);
    onLayoutChange?.(next);
    setFolds({ model, expanded: new Set() });
    if (viewport.current) viewport.current.scrollLeft = 0;
  };
  return (
    <div className="file-diff" data-layout={layout} data-scope={scope} data-format={model.format}>
      <div className="file-diff-toolbar">
        <span className="file-diff-path" title={path ? clipDiffLine(path) : undefined}>
          {path ? clipDiffLine(path) : scope === 'workspace' ? '文件差异' : '本次操作差异'}
        </span>
        {model.format !== 'plain' && (
          <span
            className="file-diff-counts"
            title={`预览新增 ${model.added} 行，删除 ${model.removed} 行`}
          >
            预览 <span className="file-diff-added-count">+{model.added}</span>{' '}
            <span className="file-diff-removed-count">-{model.removed}</span>
          </span>
        )}
        <fieldset className="file-diff-layout" aria-label="差异布局">
          <button
            type="button"
            aria-pressed={layout === 'split'}
            onClick={() => chooseLayout('split')}
          >
            双栏
          </button>
          <button
            type="button"
            aria-pressed={layout === 'unified'}
            onClick={() => chooseLayout('unified')}
          >
            统一
          </button>
        </fieldset>
        {hasContext && (
          <button
            type="button"
            className="file-diff-collapse"
            disabled={!expanded.size}
            onClick={() => {
              setFolds({ model, expanded: new Set() });
              viewport.current?.focus({ preventScroll: true });
            }}
            aria-label="折叠未变更行"
            title="折叠未变更行"
          >
            ↥
          </button>
        )}
      </div>
      {model.truncated && (
        <p className="file-diff-notice" role="status">
          预览最多 64 KiB、400 行、每行 2048 个 UTF-16 单元；部分内容未显示。
        </p>
      )}
      {model.format === 'plain' ? (
        <p className="file-diff-notice">原始输出：未识别的差异格式，不推断行号或修改前后内容。</p>
      ) : (
        <div className="file-diff-sides">
          {layout === 'unified' ? (
            <span>
              统一差异 · 旧行 / 新行 ·{' '}
              {scope === 'workspace' ? 'HEAD → 当前文件' : '本次操作前 → 操作后'}
            </span>
          ) : (
            <>
              <span>{scope === 'workspace' ? '修改前 · HEAD' : '修改前 · 本次操作前'}</span>
              <span>{scope === 'workspace' ? '修改后 · 当前文件' : '修改后 · 本次操作后'}</span>
            </>
          )}
        </div>
      )}
      <ScrollArea
        orientation="both"
        fade="y"
        className="tool-diff-scroll"
        chainScroll
        viewportRef={viewport}
        viewportClassName="tool-diff-viewport"
        viewportProps={{ role: 'region', 'aria-label': '文件差异', tabIndex: 0 }}
      >
        <div
          id={bodyId}
          className="diff-output"
          style={
            {
              '--file-diff-columns': metrics.columns,
              '--file-diff-gutter': metrics.gutter,
            } as CSSProperties
          }
        >
          {rows.map((row, index) => {
            if (row.kind === 'fold')
              return (
                <button
                  key={`fold-${row.id}`}
                  type="button"
                  className="file-diff-fold"
                  aria-expanded="false"
                  aria-controls={bodyId}
                  onClick={() => {
                    setFolds({ model, expanded: new Set([...expanded, row.id]) });
                    viewport.current?.focus({ preventScroll: true });
                  }}
                >
                  <span aria-hidden="true">⌄</span> {row.count} 行未变更 · 展开保留的上下文
                </button>
              );
            if (row.kind !== 'context' && row.kind !== 'change')
              return (
                <div key={index} className={`file-diff-row file-diff-${row.kind}`}>
                  {row.text}
                </div>
              );
            if (layout === 'unified')
              return (
                <div key={index} className="file-diff-row file-diff-unified-row">
                  <span className="file-diff-old-number">{row.before?.number ?? ''}</span>
                  <DiffCell
                    line={row.after ?? row.before}
                    side={row.after ? 'after' : 'before'}
                    showNumber={!!row.after}
                    change={row.kind === 'change'}
                  />
                </div>
              );
            return (
              <div key={index} className="file-diff-row file-diff-split-row">
                <DiffCell line={row.before} side="before" change={row.kind === 'change'} />
                <DiffCell line={row.after} side="after" change={row.kind === 'change'} />
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
