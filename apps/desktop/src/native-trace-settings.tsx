import type {
  TraceDeadLetterList,
  TraceGrantRequest,
  TraceInstallation,
  TraceInstallationList,
  TraceInstallRequest,
  TraceRemoteDeliveryStatus,
} from '@kite-ai/client';
import { decimal64Schema } from '@kite-ai/trajectory';
import { Button, Input, SelectField, Switch, Textarea } from '@kite-ai/ui/desktop';
import { useEffect, useId, useRef, useState } from 'react';
import type { NativeBridge, NativeSelection } from './native-bridge';
import type { NativeTraceOperation, NativeTraceResult } from './native-trace-bridge';

type EventKind = TraceGrantRequest['eventKinds'][number];
type EvidenceKind = TraceGrantRequest['evidenceKinds'][number];
const eventKinds: readonly EventKind[] = [
  'message',
  'command',
  'run',
  'model',
  'tool',
  'job',
  'interaction',
  'child',
  'context',
  'recovery',
  'artifact',
  'verification',
];
const evidenceKinds: readonly EvidenceKind[] = [
  'message',
  'model_input',
  'model_output',
  'tool_result',
  'job_output',
  'artifact',
  'file_change',
  'verification',
  'interaction',
  'context',
];
const eventLabels: Record<EventKind, string> = {
  message: '对话消息',
  command: '命令',
  run: '运行',
  model: '模型',
  tool: '工具',
  job: '后台执行',
  interaction: '人工交互',
  child: '子会话',
  context: '上下文',
  recovery: '恢复',
  artifact: '产物',
  verification: '检查',
};
const evidenceLabels: Record<EvidenceKind, string> = {
  message: '消息正文',
  model_input: '模型输入',
  model_output: '模型输出',
  tool_input: '工具参数',
  tool_result: '工具结果',
  job_output: '后台输出',
  artifact: '产物内容',
  file_change: '文件变化',
  verification: '检查材料',
  interaction: '交互请求与回答',
  context: '上下文版本',
};
const statusLabels: Record<string, string> = {
  installed: '已安装',
  configured: '已配置',
  enabled: '已启用',
  disabled: '已停用',
  uninstalled: '已卸载',
  active: '进行中',
  paused: '已暂停',
  cancelled: '已取消',
  revoked: '已撤销',
  unavailable: '不可用',
};
const remoteLabels: Record<string, string> = {
  pending: '待发送',
  sending: '发送中',
  accepted: '远端完整接收',
  retry_wait: '暂时失败，等待重试',
  rejected: '永久拒绝',
  partial_unknown: '部分接收，逐项结果未知',
  unconfirmed: '远端接收结果未确认',
  sampled_out: '已采样排除',
  stopped: '已停止',
};
const emptyGrant = (): TraceGrantRequest => ({
  scopes: [],
  eventKinds: [],
  metadata: [],
  evidenceKinds: [],
  origins: [],
  originalIdentity: false,
  allowHistory: false,
  allowPrivateNetwork: false,
  credentialHandles: [],
  evidenceContent: 'redacted',
});
function errorCode(cause: unknown) {
  const code =
    (cause as { code?: unknown })?.code ??
    (cause instanceof Error ? cause.message : 'trace_request_failed');
  return typeof code === 'string' && /^[a-zA-Z][a-zA-Z0-9_.:-]{0,120}$/.test(code)
    ? code
    : 'trace_request_failed';
}
function Toggle({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange(value: boolean): void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <label htmlFor={id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
      <span>{label}</span>
    </label>
  );
}
function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  type?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <label htmlFor={id} style={{ display: 'grid', gap: 4 }}>
      <span>{label}</span>
      <Input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete={type === 'password' ? 'new-password' : 'off'}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
const block = {
  display: 'grid',
  gap: 12,
  padding: 16,
  border: '1px solid var(--border)',
  borderRadius: 8,
} as const;
/** Named management operations only. Secrets live in this mounted form and are cleared on submit. */
export function NativeTraceSettings({
  bridge,
  generation,
  storeId,
  selection,
}: {
  bridge: NativeBridge;
  generation: number;
  storeId: string;
  selection?: NativeSelection;
}) {
  const [list, setList] = useState<TraceInstallationList['installations']>([]),
    [installation, setInstallation] = useState<TraceInstallation | null>(null),
    [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [packageText, setPackageText] = useState(''),
    [endpoint, setEndpoint] = useState(''),
    [sampleRate, setSampleRate] = useState('1');
  const [settings, setSettings] = useState<Record<string, string | number | boolean>>({}),
    [grant, setGrant] = useState<TraceGrantRequest>(emptyGrant);
  const [from, setFrom] = useState('0'),
    [through, setThrough] = useState(''),
    [contentMode, setContentMode] = useState<'metadata' | 'authorized_evidence'>('metadata');
  const [credentialOrigin, setCredentialOrigin] = useState(''),
    [secret, setSecret] = useState('');
  const [deadLetters, setDeadLetters] = useState<Record<string, TraceDeadLetterList>>({}),
    [remote, setRemote] = useState<TraceRemoteDeliveryStatus | null>(null);
  const alive = useRef(true),
    scopeEpoch = useRef(0),
    choice = useRef(''),
    inFlight = useRef(false);
  const packageId = useId();
  const currentSession = selection?.storeId === storeId ? selection.session.id : undefined;
  async function request(operation: NativeTraceOperation): Promise<NativeTraceResult> {
    const result = await bridge.request({ method: 'trace.manage', generation, operation });
    if (!result || !('kind' in result) || !result.kind.startsWith('trace.'))
      throw Error('trace_response_invalid');
    return result as NativeTraceResult;
  }
  async function readList(epoch = scopeEpoch.current) {
    const result = await request({ kind: 'list' });
    if (alive.current && epoch === scopeEpoch.current && result.kind === 'trace.installations')
      setList(result.value.installations);
  }
  async function readInstallation(id: string, epoch = scopeEpoch.current, resetForm = false) {
    const result = await request({ kind: 'inspect', installationId: id });
    if (
      !alive.current ||
      epoch !== scopeEpoch.current ||
      choice.current !== id ||
      result.kind !== 'trace.installation'
    )
      return;
    setInstallation(result.value);
    if (resetForm) {
      setSettings({ ...result.value.settings });
      setGrant(emptyGrant());
      setCredentialOrigin('');
      setSecret('');
      setDeadLetters({});
      setRemote(null);
    }
  }
  function clearInstallation() {
    choice.current = '';
    setSelected('');
    setInstallation(null);
    setSettings({});
    setGrant(emptyGrant());
    setRemote(null);
    setDeadLetters({});
    setCredentialOrigin('');
    setSecret('');
    setFrom('0');
    setThrough('');
    setContentMode('metadata');
  }
  async function act(operation: NativeTraceOperation, label: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const epoch = scopeEpoch.current,
      id = 'installationId' in operation ? operation.installationId : choice.current;
    try {
      const result = await request(operation);
      if (!alive.current || epoch !== scopeEpoch.current) return;
      if (result.kind === 'trace.validated') setNotice(`包校验通过：${result.value.digest}`);
      else if (result.kind === 'trace.deadLetters' && 'partitionId' in operation)
        setDeadLetters((value) => ({ ...value, [operation.partitionId]: result.value }));
      else if (result.kind === 'trace.delivery') setRemote(result.value);
      else setNotice(`${label}已完成。`);
      if (operation.kind === 'uninstall' && result.kind === 'trace.action') {
        clearInstallation();
        setList((previous) =>
          previous.filter((item) => item.installationId !== operation.installationId),
        );
      }
      await readList(epoch);
      if (id && choice.current === id) await readInstallation(id, epoch);
    } catch (cause) {
      if (alive.current && epoch === scopeEpoch.current) {
        const readOnly = [
          'list',
          'inspect',
          'validate',
          'delivery',
          'partition',
          'deadLetters',
        ].includes(operation.kind);
        setError(
          `${errorCode(cause)}。${readOnly ? '读取未完成，请刷新状态。' : '写入结果可能尚未确认，请刷新状态后再决定下一次操作。'}`,
        );
        try {
          await readList(epoch);
          if (id && choice.current === id) await readInstallation(id, epoch);
        } catch {
          /* Preserve the original outcome; no mutation is retried. */
        }
      }
    } finally {
      inFlight.current = false;
      if (alive.current && epoch === scopeEpoch.current) setBusy(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    scopeEpoch.current++;
    setSelected('');
    choice.current = '';
    setInstallation(null);
    setList([]);
    setSecret('');
    setGrant(emptyGrant());
    setRemote(null);
    setError('');
    const epoch = scopeEpoch.current;
    if (storeId)
      void bridge
        .request({ method: 'trace.manage', generation, operation: { kind: 'list' } })
        .then((result) => {
          if (
            alive.current &&
            scopeEpoch.current === epoch &&
            result &&
            'kind' in result &&
            'value' in result &&
            result.kind === 'trace.installations'
          )
            setList(result.value.installations);
        })
        .catch((cause) => {
          if (alive.current && scopeEpoch.current === epoch) setError(errorCode(cause));
        });
    return () => {
      alive.current = false;
      scopeEpoch.current++;
    };
  }, [bridge, generation, storeId]);
  useEffect(() => {
    setGrant(emptyGrant());
    setSecret('');
    setNotice(
      currentSession
        ? '授权表单仅作用于当前会话，请明确选择范围和能力。'
        : '请先选择要授权的会话。',
    );
  }, [currentSession]);
  function choose(id: string) {
    choice.current = id;
    setSelected(id);
    setInstallation(null);
    setError('');
    void readInstallation(id, scopeEpoch.current, true).catch((cause) => {
      if (alive.current && choice.current === id) setError(errorCode(cause));
    });
  }
  function parsePackage(): TraceInstallRequest {
    const value: unknown = JSON.parse(packageText);
    if (!value || typeof value !== 'object' || !('manifest' in value) || !('bundle' in value))
      throw Error('trace_bundle_input_invalid');
    return value as TraceInstallRequest;
  }
  function packageAction(kind: 'validate' | 'install' | 'update') {
    try {
      const input = parsePackage();
      void act(
        kind === 'update' ? { kind, installationId: selected, input } : { kind, input },
        kind === 'validate' ? '校验包' : kind === 'update' ? '更新安装' : '安装',
      );
    } catch (cause) {
      setError(errorCode(cause));
    }
  }
  function toggleArray<
    K extends 'eventKinds' | 'evidenceKinds' | 'metadata' | 'origins' | 'credentialHandles',
  >(key: K, value: NonNullable<TraceGrantRequest[K]>[number], checked: boolean) {
    setGrant((previous) => ({
      ...previous,
      [key]: checked
        ? [...new Set([...(previous[key] ?? []), value])]
        : previous[key]?.filter((item) => item !== value),
    }));
  }
  const installed = installation && installation.status !== 'uninstalled';
  return (
    <section
      aria-label="Trace 设置"
      style={{ display: 'grid', gap: 20, padding: 20, maxWidth: 960, margin: '0 auto' }}
    >
      <header>
        <h2>Trace 导出</h2>
        <p>安装、配置、授权和启用分别操作。只向明确授权的目标发送执行事实与材料。</p>
      </header>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <section style={block} aria-label="安装 Trace">
        <h3>安装</h3>
        <label htmlFor={packageId} style={{ display: 'grid', gap: 4 }}>
          第三方包（manifest 与 bundle JSON）
          <Textarea
            id={packageId}
            aria-label="第三方 Trace 包"
            value={packageText}
            onChange={(event) => setPackageText(event.target.value)}
            rows={5}
          />
        </label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button disabled={busy || !packageText.trim()} onClick={() => packageAction('validate')}>
            校验包
          </Button>
          <Button disabled={busy || !packageText.trim()} onClick={() => packageAction('install')}>
            安装第三方包
          </Button>
          <Button
            disabled={busy || !selected || !packageText.trim()}
            onClick={() => packageAction('update')}
          >
            更新所选安装
          </Button>
        </div>
        <Field
          label="OpenTelemetry 接收端点"
          value={endpoint}
          onChange={setEndpoint}
          placeholder="https://collector.example/v1/traces"
        />
        <Field label="采样率（0–1）" value={sampleRate} onChange={setSampleRate} type="number" />
        <Button
          disabled={busy || !endpoint.trim()}
          onClick={() => {
            const rate = Number(sampleRate);
            if (!sampleRate.trim() || !Number.isFinite(rate) || rate < 0 || rate > 1) {
              setError('trace_sample_rate_invalid');
              return;
            }
            void act(
              {
                kind: 'installOpenTelemetry',
                input: { endpoint: endpoint.trim(), sampleRate: rate },
              },
              '安装 OpenTelemetry',
            );
          }}
        >
          安装官方 OpenTelemetry
        </Button>
        <p>安装后仍需单独授权和启用。</p>
      </section>
      <section style={block} aria-label="Trace 安装列表">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3>已安装</h3>
          <Button disabled={busy} onClick={() => void act({ kind: 'list' }, '刷新状态')}>
            刷新状态
          </Button>
        </div>
        {list.length === 0 ? (
          <p>尚无安装。</p>
        ) : (
          <ul>
            {list.map((item) => (
              <li
                key={item.installationId}
                style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0' }}
              >
                <Button
                  variant={item.installationId === selected ? 'secondary' : 'ghost'}
                  disabled={busy}
                  onClick={() => choose(item.installationId)}
                >
                  {item.name}
                </Button>
                <span>
                  {item.kind === 'opentelemetry' ? '官方 OpenTelemetry' : '第三方'} ·{' '}
                  {statusLabels[item.status]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {installation && (
        <>
          <section style={block} aria-label="所选 Trace">
            <h3>{installation.name}</h3>
            <p>
              {statusLabels[installation.status]} · {installation.digest}
            </p>
            <p>
              授权：
              {installation.grant?.active
                ? `有效，修订 ${installation.grant.revision} / epoch ${installation.grant.epoch}`
                : '未授权或已撤销'}
            </p>
            {installation.grant && (
              <details>
                <summary>查看已保存授权</summary>
                <dl>
                  <dt>范围</dt>
                  <dd>
                    {installation.grant.grant.scopes
                      .map((scope) =>
                        [scope.storeId, scope.sessionId, scope.runId, scope.executionId]
                          .filter(Boolean)
                          .join(' / '),
                      )
                      .join('；') || '无'}
                  </dd>
                  <dt>事件</dt>
                  <dd>
                    {installation.grant.grant.eventKinds
                      .map((kind) => eventLabels[kind])
                      .join('、') || '无'}
                  </dd>
                  <dt>元数据</dt>
                  <dd>{installation.grant.grant.metadata.join('、') || '无'}</dd>
                  <dt>Evidence</dt>
                  <dd>
                    {installation.grant.grant.evidenceKinds
                      .map((kind) => evidenceLabels[kind])
                      .join('、') || '无'}{' '}
                    ·{' '}
                    {installation.grant.grant.evidenceContent === 'full'
                      ? '完整授权材料'
                      : '脱敏材料'}
                  </dd>
                  <dt>原始身份 / 历史 / 私有网络</dt>
                  <dd>
                    {[
                      installation.grant.grant.originalIdentity,
                      installation.grant.grant.allowHistory,
                      installation.grant.grant.allowPrivateNetwork === true,
                    ]
                      .map((value) => (value ? '允许' : '不允许'))
                      .join(' / ')}
                  </dd>
                  <dt>精确来源</dt>
                  <dd>{installation.grant.grant.origins.join('、') || '无'}</dd>
                  <dt>凭据句柄</dt>
                  <dd>{installation.grant.grant.credentialHandles?.join('、') || '无'}</dd>
                </dl>
              </details>
            )}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {(['enable', 'disable', 'revoke', 'uninstall'] as const).map((kind) => (
                <Button
                  key={kind}
                  disabled={busy || !installed}
                  onClick={() =>
                    void act(
                      { kind, installationId: selected },
                      { enable: '启用', disable: '停用', revoke: '撤销授权', uninstall: '卸载' }[
                        kind
                      ],
                    )
                  }
                >
                  {{ enable: '启用', disable: '停用', revoke: '撤销授权', uninstall: '卸载' }[kind]}
                </Button>
              ))}
            </div>
          </section>
          {installed && (
            <>
              <section style={block} aria-label="Trace 配置">
                <h3>配置</h3>
                {Object.entries(installation.manifest.settings).map(([key, type]) =>
                  type === 'boolean' ? (
                    <Toggle
                      key={key}
                      label={key}
                      checked={settings[key] === true}
                      onChange={(value) =>
                        setSettings((previous) => ({ ...previous, [key]: value }))
                      }
                    />
                  ) : (
                    <Field
                      key={key}
                      label={key}
                      type={type === 'number' ? 'number' : 'text'}
                      value={String(settings[key] ?? '')}
                      onChange={(value) =>
                        setSettings((previous) => ({
                          ...previous,
                          [key]: type === 'number' ? Number(value) : value,
                        }))
                      }
                    />
                  ),
                )}
                <Button
                  disabled={busy}
                  onClick={() =>
                    void act(
                      { kind: 'configure', installationId: selected, input: { settings } },
                      '保存配置',
                    )
                  }
                >
                  保存配置
                </Button>
              </section>
              <section style={block} aria-label="Trace 独立授权">
                <h3>独立授权</h3>
                <p>
                  每次保存会替换本安装的授权。未选择的能力保持未授权；配置和安装不会代替此步骤。
                </p>
                <Toggle
                  label={currentSession ? `当前会话：${currentSession}` : '请先选择当前会话'}
                  checked={grant.scopes.length > 0}
                  disabled={!currentSession || busy}
                  onChange={(checked) =>
                    setGrant((previous) => ({
                      ...previous,
                      scopes:
                        checked && currentSession ? [{ storeId, sessionId: currentSession }] : [],
                    }))
                  }
                />
                <fieldset disabled={busy}>
                  <legend>事件种类</legend>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))',
                      gap: 8,
                    }}
                  >
                    {eventKinds
                      .filter((kind) => installation.manifest.eventKinds.includes(kind))
                      .map((kind) => (
                        <Toggle
                          key={kind}
                          label={eventLabels[kind]}
                          checked={grant.eventKinds.includes(kind)}
                          onChange={(checked) => toggleArray('eventKinds', kind, checked)}
                        />
                      ))}
                  </div>
                </fieldset>
                <fieldset disabled={busy}>
                  <legend>元数据</legend>
                  {(['timing', 'usage', 'output_checkpoint'] as const).map((kind) => (
                    <Toggle
                      key={kind}
                      label={
                        {
                          timing: '真实时间',
                          usage: '模型用量',
                          output_checkpoint: '输出前缀与缺口元数据',
                        }[kind]
                      }
                      checked={grant.metadata.includes(kind)}
                      onChange={(checked) => toggleArray('metadata', kind, checked)}
                    />
                  ))}
                </fieldset>
                <fieldset disabled={busy}>
                  <legend>Evidence 材料种类</legend>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))',
                      gap: 8,
                    }}
                  >
                    {evidenceKinds
                      .filter((kind) => installation.manifest.evidenceKinds.includes(kind))
                      .map((kind) => (
                        <Toggle
                          key={kind}
                          label={evidenceLabels[kind]}
                          checked={grant.evidenceKinds.includes(kind)}
                          onChange={(checked) => toggleArray('evidenceKinds', kind, checked)}
                        />
                      ))}
                  </div>
                </fieldset>
                <SelectField
                  aria-label="Evidence 内容授权"
                  value={grant.evidenceContent ?? 'redacted'}
                  options={[
                    { value: 'redacted', label: '脱敏材料' },
                    { value: 'full', label: '完整已授权材料' },
                  ]}
                  onValueChange={(value) =>
                    setGrant((previous) => ({
                      ...previous,
                      evidenceContent: value as 'redacted' | 'full',
                    }))
                  }
                />
                <Toggle
                  label="原始身份（Store / Run / Execution 等 ID）"
                  checked={grant.originalIdentity}
                  onChange={(value) =>
                    setGrant((previous) => ({ ...previous, originalIdentity: value }))
                  }
                />
                <Toggle
                  label="允许历史导出"
                  checked={grant.allowHistory}
                  disabled={!installation.manifest.history}
                  onChange={(value) =>
                    setGrant((previous) => ({ ...previous, allowHistory: value }))
                  }
                />
                <Toggle
                  label="允许访问私有网络地址"
                  checked={grant.allowPrivateNetwork === true}
                  onChange={(value) =>
                    setGrant((previous) => ({ ...previous, allowPrivateNetwork: value }))
                  }
                />
                <fieldset disabled={busy}>
                  <legend>精确网络来源</legend>
                  {installation.manifest.origins.length === 0 ? (
                    <p>此安装未声明网络来源。</p>
                  ) : (
                    installation.manifest.origins.map((origin) => (
                      <Toggle
                        key={origin}
                        label={origin}
                        checked={grant.origins.includes(origin)}
                        onChange={(checked) => toggleArray('origins', origin, checked)}
                      />
                    ))
                  )}
                </fieldset>
                <fieldset disabled={busy}>
                  <legend>凭据用途（仅授权选定句柄）</legend>
                  {installation.credentials.filter((item) => item.active).length === 0 ? (
                    <p>尚无可授权凭据。</p>
                  ) : (
                    installation.credentials
                      .filter((item) => item.active)
                      .map((item) => (
                        <Toggle
                          key={item.handle}
                          label={`${item.origin} · ${item.handle}`}
                          checked={grant.credentialHandles?.includes(item.handle) === true}
                          onChange={(checked) =>
                            toggleArray('credentialHandles', item.handle, checked)
                          }
                        />
                      ))
                  )}
                </fieldset>
                <Button
                  disabled={busy || grant.scopes.length === 0 || grant.eventKinds.length === 0}
                  onClick={() =>
                    void act({ kind: 'grant', installationId: selected, input: grant }, '替换授权')
                  }
                >
                  保存并替换授权
                </Button>
              </section>
              <section style={block} aria-label="Trace 凭据">
                <h3>绑定凭据</h3>
                <p>凭据绑定到精确来源。绑定后仍需在上面的授权中选择句柄。</p>
                <SelectField
                  aria-label="凭据来源"
                  value={credentialOrigin}
                  options={[
                    { value: '', label: '选择精确来源' },
                    ...installation.manifest.origins.map((value) => ({ value, label: value })),
                  ]}
                  onValueChange={setCredentialOrigin}
                />
                <Field label="凭据" type="password" value={secret} onChange={setSecret} />
                <Button
                  disabled={busy || !credentialOrigin || !secret}
                  onClick={() => {
                    const value = secret;
                    setSecret('');
                    void act(
                      {
                        kind: 'bindCredential',
                        installationId: selected,
                        input: { origin: credentialOrigin, secret: value },
                      },
                      '绑定凭据',
                    );
                  }}
                >
                  绑定凭据
                </Button>
                {installation.credentials.map((item) => (
                  <div key={item.handle} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>
                      {item.origin} · {item.handle} · {item.active ? '有效' : '不可用'}
                    </span>
                    <Button
                      disabled={busy || !item.active}
                      onClick={() =>
                        void act(
                          {
                            kind: 'revokeCredential',
                            installationId: selected,
                            input: { handle: item.handle },
                          },
                          '撤销凭据',
                        )
                      }
                    >
                      撤销凭据
                    </Button>
                  </div>
                ))}
              </section>
              <section style={block} aria-label="Trace 历史导出">
                <h3>创建历史导出</h3>
                <p>
                  范围固定在所选会话，游标使用原始十进制字符串。授权与内容模式仍由 Service
                  逐次检查。
                </p>
                <Field label="起始序号（含）" value={from} onChange={setFrom} />
                <Field
                  label="结束序号（含；留空固定为当前上界）"
                  value={through}
                  onChange={setThrough}
                />
                <SelectField
                  aria-label="历史内容模式"
                  value={contentMode}
                  options={[
                    { value: 'metadata', label: '仅元数据' },
                    { value: 'authorized_evidence', label: '包含已授权 Evidence' },
                  ]}
                  onValueChange={(value) => setContentMode(value as typeof contentMode)}
                />
                <Button
                  disabled={
                    busy ||
                    !currentSession ||
                    !installation.grant?.active ||
                    !installation.grant.grant.allowHistory
                  }
                  onClick={() => {
                    if (
                      !decimal64Schema.safeParse(from).success ||
                      (through && !decimal64Schema.safeParse(through).success) ||
                      (through && BigInt(from) > BigInt(through))
                    ) {
                      setError('trace_history_range_invalid');
                      return;
                    }
                    void act(
                      {
                        kind: 'history',
                        installationId: selected,
                        input: {
                          scope: { storeId, sessionId: currentSession! },
                          fromSequence: from,
                          ...(through ? { toSequence: through } : {}),
                          contentMode,
                        },
                      },
                      '创建历史导出',
                    );
                  }}
                >
                  创建历史导出
                </Button>
              </section>
            </>
          )}
          <section style={block} aria-label="Host 投递状态">
            <h3>Host 连续 ACK 与分区</h3>
            <p>Host ACK 表示插件已处理该连续前缀。远端接收状态另见下方。</p>
            {installation.partitions.length === 0 ? (
              <p>尚无投递分区。</p>
            ) : (
              installation.partitions.map((partition) => (
                <section key={partition.id} style={block}>
                  <h4>
                    {partition.lane === 'history' ? '历史' : '实时'} · {partition.id}
                  </h4>
                  <dl>
                    <dt>状态</dt>
                    <dd>
                      {statusLabels[partition.status]} · {partition.contentMode}
                    </dd>
                    <dt>固定范围</dt>
                    <dd>
                      {partition.fromCursor}–{partition.upperCursor}
                    </dd>
                    <dt>已扫描</dt>
                    <dd>{partition.sourceScanPosition}</dd>
                    <dt>连续 ACK</dt>
                    <dd>{partition.contiguousAcknowledgedPosition}</dd>
                    <dt>待处理 / 死信</dt>
                    <dd>
                      {partition.pending} / {partition.deadLetter}
                    </dd>
                    <dt>事实完整性</dt>
                    <dd>
                      {partition.integrity.facts} ·{' '}
                      {partition.integrity.reasons.join('、') || '无缺口说明'}
                    </dd>
                  </dl>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {(
                      ['partition', 'pause', 'resume', 'cancel', 'retry', 'deadLetters'] as const
                    ).map((kind) => (
                      <Button
                        key={kind}
                        disabled={busy}
                        onClick={() =>
                          void act(
                            { kind, installationId: selected, partitionId: partition.id },
                            {
                              partition: '刷新分区',
                              pause: '暂停',
                              resume: '继续',
                              cancel: '取消',
                              retry: '重试死信',
                              deadLetters: '查看死信',
                            }[kind],
                          )
                        }
                      >
                        {
                          {
                            partition: '刷新分区',
                            pause: '暂停',
                            resume: '继续',
                            cancel: '取消',
                            retry: '重试死信',
                            deadLetters: '查看死信',
                          }[kind]
                        }
                      </Button>
                    ))}
                  </div>
                  {deadLetters[partition.id] && (
                    <ul>
                      {deadLetters[partition.id]!.entries.length === 0 ? (
                        <li>没有死信。</li>
                      ) : (
                        deadLetters[partition.id]!.entries.map((entry) => (
                          <li key={entry.eventId}>
                            #{entry.sequence} · {entry.reason} · 已尝试 {entry.attempts} 次
                          </li>
                        ))
                      )}
                    </ul>
                  )}
                </section>
              ))
            )}
          </section>
          <section style={block} aria-label="远端接收状态">
            <h3>远端接收状态</h3>
            <Button
              disabled={busy}
              onClick={() =>
                void act({ kind: 'delivery', installationId: selected }, '检查远端状态')
              }
            >
              检查远端状态
            </Button>
            {!remote ? (
              <p>尚未读取远端状态。</p>
            ) : remote.kind === 'third_party' ? (
              <p>第三方安装：无官方远端接收状态。</p>
            ) : remote.status === 'not_started' ? (
              <p>OpenTelemetry 尚未启动。</p>
            ) : remote.status === 'unavailable' ? (
              <p>远端状态暂不可用：{remote.code}</p>
            ) : (
              <>
                <p>
                  已接收事实 {remote.inspection.acceptedEvents}；未闭合 span{' '}
                  {remote.inspection.openSpans}；发送记录 {remote.inspection.outgoingTotal}。
                </p>
                <p>
                  未映射：非 span {remote.inspection.unmappedEvents.notSpan}，身份缺失{' '}
                  {remote.inspection.unmappedEvents.identityUnavailable}，时间缺失{' '}
                  {remote.inspection.unmappedEvents.timingUnavailable}，前缀不完整{' '}
                  {remote.inspection.unmappedEvents.incompletePrefix}。
                </p>
                <ul>
                  {remote.inspection.outgoingStates.map((item) => (
                    <li key={item.status}>
                      {remoteLabels[item.status]}：{item.count}
                    </li>
                  ))}
                </ul>
                <ul>
                  {remote.inspection.outgoing.map((item) => (
                    <li key={item.key}>
                      {remoteLabels[item.status]} · {item.code ?? '无错误码'} · 尝试 {item.attempts}{' '}
                      次{item.rejectedCount === null ? '' : ` · 拒收 ${item.rejectedCount} 项`}
                      {item.possibleDuplicate === 1 ? ' · 可能重复' : ''}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </>
      )}
    </section>
  );
}
