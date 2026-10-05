import type { PermissionModeState, WorkspaceTrustState } from '@kite-ai/client';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';

function keyboardClick(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    if (!event.repeat && !event.currentTarget.disabled) event.currentTarget.click();
  }
}

export type PermissionFacts = {
  readonly mode: PermissionModeState;
  readonly trust: WorkspaceTrustState;
};
export type PermissionSubmissionNotice = {
  readonly commandId: string;
  readonly phase: 'saved' | 'submitting' | 'applied' | 'unknown' | 'failed';
  readonly error?: string;
};
/** Facts are public projections; callbacks belong to the admitted Native host. */
export function PermissionPanel(props: {
  facts?: PermissionFacts;
  busy?: boolean;
  onSetMode?: (mode: PermissionModeState['mode'], makeDefault: boolean) => Promise<unknown>;
  onSetTrust?: (trusted: boolean) => Promise<unknown>;
  onRefresh?: () => Promise<unknown>;
}) {
  const key = props.facts ? JSON.stringify(props.facts) : 'unavailable';
  return <PermissionChoices key={key} {...props} />;
}
function PermissionChoices({
  facts,
  busy = false,
  onSetMode,
  onSetTrust,
  onRefresh,
}: Parameters<typeof PermissionPanel>[0]) {
  const [mode, setMode] = useState<PermissionModeState['mode'] | ''>('');
  const [makeDefault, setDefault] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [submitted, setSubmitted] = useState(false);
  const running = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const child = !!facts && facts.mode.sessionId !== facts.mode.scopeSessionId;
  const disabled = busy || pending || submitted || child;
  async function submit(action: () => Promise<unknown>) {
    if (disabled || running.current) return;
    running.current = true;
    setPending(true);
    setError(undefined);
    try {
      await action();
      if (alive.current) setSubmitted(true);
    } catch {
      if (alive.current) {
        setSubmitted(true);
        setError('未确认应用。保留原选择；请核对原回执，或重新读取后再明确选择。');
      }
    } finally {
      running.current = false;
      if (alive.current) setPending(false);
    }
  }
  if (!facts) return <p>权限控制不可用；当前只读。</p>;
  return (
    <section aria-label="权限与工作区信任">
      <p>
        当前模式：{facts.mode.mode}；默认模式：{facts.mode.defaultMode}
      </p>
      <p>
        会话：{facts.mode.sessionId}；权限范围：{facts.mode.scopeSessionId}；版本：
        {facts.mode.revision} / {facts.mode.defaultRevision}
      </p>
      {child && <p>子会话继承根会话权限，此处只读。</p>}
      {!onSetMode && <p>模式只读。</p>}
      {onSetMode && !child && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (mode) void submit(() => onSetMode(mode, makeDefault));
          }}
        >
          <fieldset disabled={disabled}>
            <legend>明确选择权限模式</legend>
            {(['ask', 'accept_edits', 'auto', 'full'] as const).map((value) => (
              <label key={value}>
                <input
                  type="radio"
                  name="permission-mode"
                  checked={mode === value}
                  onChange={() => setMode(value)}
                />
                {{ ask: 'Ask', accept_edits: 'Accept Edits', auto: 'Auto', full: 'Full' }[value]}
              </label>
            ))}
            <label>
              <input
                type="checkbox"
                checked={makeDefault}
                onChange={(event) => setDefault(event.target.checked)}
              />
              同时设为以后会话的默认模式
            </label>
            <button type="submit" onKeyDown={keyboardClick} disabled={!mode}>
              保存模式选择
            </button>
          </fieldset>
        </form>
      )}
      <p>
        工作区：{facts.trust.workspaceId}；信任状态：{facts.trust.status}；版本：
        {facts.trust.revision}
      </p>
      <p>工作区身份摘要：{facts.trust.canonicalIdentity}</p>
      <p>额外读取范围摘要：{facts.trust.externalReadScopeDigest}</p>
      <ul>
        {facts.trust.readScopes.map((scope, index) => (
          <li key={index}>
            {scope.kind}：{scope.description}
          </li>
        ))}
      </ul>
      <p>信任只确认所显示的项目及读取范围，不批准任意操作，也不撤回已经执行的效果。</p>
      {onSetTrust && !child ? (
        <fieldset disabled={disabled}>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            我已核对所显示的工作区与读取范围
          </label>
          <button
            type="button"
            onKeyDown={keyboardClick}
            disabled={!confirmed}
            onClick={() => void submit(() => onSetTrust(true))}
          >
            信任所显示的范围
          </button>
          <button
            type="button"
            onKeyDown={keyboardClick}
            onClick={() => void submit(() => onSetTrust(false))}
          >
            撤销工作区信任
          </button>
        </fieldset>
      ) : (
        <p>工作区信任只读。</p>
      )}
      {pending && <p role="status">正在提交原选择…</p>}
      {submitted && !error && <p role="status">回执已收到；当前显示的是提交前事实，请重新读取。</p>}
      {error && <p role="alert">{error}</p>}
      {onRefresh && (
        <button
          type="button"
          disabled={busy || pending}
          onClick={() => {
            void onRefresh().catch(() => {
              if (alive.current) setError('未能重新读取；当前事实和原选择保留。');
            });
          }}
        >
          重新读取权限事实
        </button>
      )}
    </section>
  );
}
export function PermissionSubmissionStatus({
  submission,
}: {
  submission: PermissionSubmissionNotice;
}) {
  const labels = {
    saved: '选择已保存',
    submitting: '正在提交',
    applied: '选择已应用',
    unknown: '结果待核实；只查询原选择',
    failed: '选择未应用；重新读取后再选择',
  };
  return (
    <p role={submission.phase === 'failed' ? 'alert' : 'status'}>
      {labels[submission.phase]} · {submission.commandId}
      {submission.error ? ` · ${submission.error}` : ''}
    </p>
  );
}

export type PermissionGrantFacts = {
  readonly observationId: number;
  readonly page: import('@kite-ai/client').PermissionGrantPage;
};
/** This directory reports accepted grants, and never treats its projection as permission. */
export function PermissionGrantsPanel(props: {
  facts?: PermissionGrantFacts;
  busy?: boolean;
  onRead?: () => Promise<unknown>;
  onNext?: () => Promise<unknown>;
  onClear?: (observationId: number) => Promise<unknown>;
}) {
  const key = props.facts
    ? `${props.facts.page.storeId}/${props.facts.page.sessionId}/${props.facts.observationId}`
    : 'unavailable';
  return <GrantDirectory key={key} {...props} />;
}
function GrantDirectory({
  facts,
  busy = false,
  onRead,
  onNext,
  onClear,
}: Parameters<typeof PermissionGrantsPanel>[0]) {
  const [confirmed, setConfirmed] = useState(false),
    [pending, setPending] = useState(false),
    [submitted, setSubmitted] = useState(false),
    [error, setError] = useState(false);
  const running = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const disabled = busy || pending || submitted;
  async function clear() {
    if (!facts || !onClear || !confirmed || disabled || running.current) return;
    const observed = facts.observationId;
    running.current = true;
    setPending(true);
    try {
      await onClear(observed);
      if (alive.current) setSubmitted(true);
    } catch {
      if (alive.current) {
        setError(true);
        setSubmitted(true);
      }
    } finally {
      running.current = false;
      if (alive.current) setPending(false);
    }
  }
  return (
    <section aria-label="当前会话授权目录">
      {facts ? (
        <>
          <p>
            原存储：{facts.page.storeId}；实际会话：{facts.page.sessionId}；授权版本：
            {facts.page.revision}
          </p>
          <p>这些是已接受的授权事实，不代替当前策略，也不批准新的工作。子会话有独立目录。</p>
          {facts.page.items.length === 0 && <p>此页没有授权记录。</p>}
          <ul>
            {facts.page.items.map(({ seq, grant }) => (
              <li key={grant.id}>
                <p>
                  {grant.kind} · {grant.definitionId}@{grant.definitionVersion}
                </p>
                <p>
                  会话 {grant.sessionId} · 工作区 {grant.workspaceId} · 原存储 {grant.originStoreId}{' '}
                  · 序号 {seq}
                </p>
                <p>
                  审批 {grant.interactionId} · 决策版本 {grant.decisionRevision} · 原执行{' '}
                  {grant.executionId}
                </p>
                <p>
                  输入摘要 {grant.inputDigest}
                  {grant.commandDigest ? ` · 命令摘要 ${grant.commandDigest}` : ''}
                </p>
              </li>
            ))}
          </ul>
          {facts.page.nextAfterSeq !== null && onNext && (
            <button type="button" disabled={pending} onClick={() => void onNext().catch(() => {})}>
              下一页授权记录
            </button>
          )}
          {onClear ? (
            <fieldset disabled={disabled}>
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                我已核对实际会话与授权版本
              </label>
              <button
                type="button"
                disabled={!confirmed}
                onKeyDown={keyboardClick}
                onClick={() => void clear()}
              >
                清除当前会话授权
              </button>
              <p>清除该会话所显示版本的全部授权，不撤回已执行的效果；并发变化会拒绝这次选择。</p>
            </fieldset>
          ) : (
            <p>授权目录只读。</p>
          )}
        </>
      ) : (
        <p>授权目录尚未核实；当前只读。</p>
      )}
      {pending && <p role="status">正在提交原会话清除选择…</p>}
      {submitted && !error && <p role="status">回执已收到；请重新读取授权事实。</p>}
      {error && (
        <p role="alert">清除结果尚未核实。保留原选择，只查询原回执；冲突需重新读取后明确选择。</p>
      )}
      {onRead && (
        <button type="button" disabled={pending} onClick={() => void onRead().catch(() => {})}>
          读取当前会话授权
        </button>
      )}
    </section>
  );
}
