import { useState } from 'react';
import type { BrowserAnnotationDrafts, BrowserNoteDraft } from './browser-annotation-drafts';

function NoteCard({
  item,
  owner,
  scope,
}: {
  item: BrowserNoteDraft;
  owner: BrowserAnnotationDrafts;
  scope: string;
}) {
  const [editing, setEditing] = useState(false),
    [text, setText] = useState(item.note);
  const locked = owner.locked(scope, item.id) || item.status === 'preparing';
  return (
    <article className="browser-note-card">
      <div className="browser-note-thumb">
        {item.frame.data ? (
          <>
            <img alt="所选元素的历史快照" src={`data:image/jpeg;base64,${item.frame.data}`} />
            <span
              className="agent-browser-region is-selected"
              style={{
                left: `${(item.element.box.x / item.frame.width) * 100}%`,
                top: `${(item.element.box.y / item.frame.height) * 100}%`,
                width: `${(item.element.box.width / item.frame.width) * 100}%`,
                height: `${(item.element.box.height / item.frame.height) * 100}%`,
              }}
            />
          </>
        ) : (
          <span>快照未恢复</span>
        )}
      </div>
      <div>
        <strong title={item.element.name}>
          {item.element.role} · {item.element.name || item.element.ref}
        </strong>
        <small title={item.source.url}>{item.source.title || item.source.url} · 历史快照</small>
        {editing ? (
          <textarea
            aria-label="编辑注释"
            maxLength={2000}
            value={text}
            onChange={(event) => setText(event.currentTarget.value)}
          />
        ) : (
          <p>{item.note || '关注此元素'}</p>
        )}
        {item.status === 'preparing' && <small role="status">正在准备快照…</small>}
        {item.error && <small role="status">{item.error}</small>}
        <div className="browser-note-actions">
          {editing ? (
            <>
              <button
                type="button"
                disabled={locked}
                onClick={() => {
                  if (owner.edit(scope, item.id, text)) setEditing(false);
                }}
              >
                保存
              </button>
              <button type="button" onClick={() => setEditing(false)}>
                取消
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={locked}
              onClick={() => {
                setText(item.note);
                setEditing(true);
              }}
            >
              编辑
            </button>
          )}
          <button type="button" disabled={locked} onClick={() => owner.remove(scope, item.id)}>
            删除
          </button>
        </div>
      </div>
    </article>
  );
}
export function BrowserAnnotationCards({
  owner,
  scope,
  error,
}: {
  owner: BrowserAnnotationDrafts;
  scope: string;
  error?: string;
}) {
  const notes = owner.get(scope);
  if (!notes.length && !error) return null;
  return (
    <div className="browser-note-context">
      <details>
        <summary>⌖ {notes.length} 条网页注释</summary>
        <div className="browser-note-list">
          {notes.map((item) => (
            <NoteCard key={item.id} item={item} owner={owner} scope={scope} />
          ))}
        </div>
      </details>
      {owner.pending(scope) && (
        <p role="status">
          {owner.pending(scope) === 'unknown'
            ? '原发送结果待核实；注释保留且不会重复发送。'
            : '正在提交这份注释…'}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
