import {
  AiBrain01Icon,
  ArrowDown01Icon,
  Plug01Icon,
  PuzzleIcon,
  Search01Icon,
  Settings01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { AppModelProviderType } from '@kite-ai/kite-app-contract';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  RightSidebar,
} from '@kite-ai/kite-client-ui';
import { useRef, useState } from 'react';
import type { DesktopClient, DesktopView } from './client';
import { Extensions } from './Extensions';

const readinessLabel = {
  ready: '可用',
  not_configured: '未配置',
  degraded: '部分可用',
  unavailable: '不可用',
} as const;

const providerLabel = {
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  'openai-compatible': 'OpenAI Compatible',
  ollama: 'Ollama',
} as const;

const providerOptions = [
  { type: 'openai', label: 'OpenAI', description: '使用 OpenAI API 模型' },
  { type: 'deepseek', label: 'DeepSeek', description: '使用 DeepSeek API 模型' },
  {
    type: 'openai-compatible',
    label: '兼容服务',
    description: '通过基础 URL 连接 OpenAI 兼容服务',
  },
  { type: 'ollama', label: 'Ollama', description: '连接本机或指定地址的 Ollama 服务' },
] as const;

export function Settings({
  client,
  view,
  busy,
  actionPending = false,
  act,
  editor,
  onEditorChange,
}: {
  editor: 'vscode' | 'zed' | 'textedit';
  onEditorChange: (editor: 'vscode' | 'zed' | 'textedit') => void;
  client: DesktopClient;
  view: DesktopView;
  busy: boolean;
  actionPending?: boolean;
  act: (action: () => Promise<unknown>, showBusy?: boolean) => Promise<void>;
}) {
  const [section, setSection] = useState<'general' | 'providers' | 'models' | 'mcp' | 'skills'>(
    'general',
  );
  const [search, setSearch] = useState('');
  const [provider, setProvider] = useState<AppModelProviderType>('openai');
  const [editingProvider, setEditingProvider] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState<
    | { type: 'select' | 'refresh' | 'provider' }
    | { type: 'enabled'; provider: string; name: string; enabled: boolean }
  >();
  const actionBlocked = busy || actionPending || pending !== undefined;
  const runModelAction = (
    operation: NonNullable<typeof pending>,
    action: () => Promise<unknown>,
  ) => {
    if (actionBlocked || !view.connected) return;
    void act(async () => {
      setPending(operation);
      try {
        await action();
      } finally {
        setPending(undefined);
      }
    }, false);
  };
  const [formErrors, setFormErrors] = useState<{ apiKey?: string; baseURL?: string }>({});
  const keyInput = useRef<HTMLInputElement>(null);
  const baseURLInput = useRef<HTMLInputElement>(null);
  const providerButton = useRef<HTMLButtonElement>(null);
  const closeProvider = () => {
    setEditingProvider(false);
    setFormErrors({});
    providerButton.current?.focus();
  };
  const matchesSearch = (label: string) =>
    label.toLowerCase().includes(search.trim().toLowerCase());
  const personalSections = [['general', '常规', Settings01Icon]] as const;
  const providerSections = [
    ['providers', '提供商', Plug01Icon],
    ['models', '模型', AiBrain01Icon],
  ] as const;
  const integrationSections = [
    ['mcp', 'MCP', Plug01Icon],
    ['skills', 'Skills', PuzzleIcon],
  ] as const;
  const selectableModels =
    view.models?.providers.flatMap((item) =>
      item.readiness === 'ready' ? item.models.filter((model) => model.enabled !== false) : [],
    ) ?? [];
  const selectedModelValue = view.models?.selected
    ? JSON.stringify([view.models.selected.provider, view.models.selected.name])
    : '';
  const selectedModelAvailable = selectableModels.some(
    (model) => JSON.stringify([model.provider, model.name]) === selectedModelValue,
  );
  return (
    <div
      className={`settings settings-layout desktop-settings${editingProvider && section === 'providers' ? ' has-provider-panel' : ''}`}
    >
      <aside className="settings-sidebar">
        <label className="settings-search">
          <span className="sr-only">搜索设置</span>
          <HugeiconsIcon icon={Search01Icon} aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索设置…"
          />
        </label>
        <nav aria-label="设置分类">
          {personalSections.some(([, label]) => matchesSearch(label)) && <p>个人</p>}
          {personalSections
            .filter(([, label]) => matchesSearch(label))
            .map(([id, label, icon]) => (
              <Button
                key={id}
                aria-pressed={section === id}
                onClick={() => {
                  setSection(id);
                  setEditingProvider(false);
                }}
              >
                <HugeiconsIcon icon={icon} data-icon="inline-start" aria-hidden="true" />
                {label}
              </Button>
            ))}
          {providerSections.some(([, label]) => matchesSearch(label)) && <p>模型服务</p>}
          {providerSections
            .filter(([, label]) => matchesSearch(label))
            .map(([id, label, icon]) => (
              <Button
                key={id}
                aria-pressed={section === id}
                onClick={() => {
                  setSection(id);
                  setEditingProvider(false);
                }}
              >
                <HugeiconsIcon icon={icon} data-icon="inline-start" aria-hidden="true" />
                {label}
              </Button>
            ))}
          {integrationSections.some(([, label]) => matchesSearch(label)) && <p>扩展</p>}
          {integrationSections
            .filter(([, label]) => matchesSearch(label))
            .map(([id, label, icon]) => (
              <Button
                key={id}
                aria-pressed={section === id}
                onClick={() => {
                  setSection(id);
                  setEditingProvider(false);
                }}
              >
                <HugeiconsIcon icon={icon} data-icon="inline-start" aria-hidden="true" />
                {label}
              </Button>
            ))}
          {![...personalSections, ...providerSections, ...integrationSections].some(([, label]) =>
            matchesSearch(label),
          ) && <span className="settings-search-empty">没有匹配的设置分类</span>}
        </nav>
      </aside>
      <div className="settings-content">
        {view.error && (
          <p className="notice error" role="alert">
            {view.error}
          </p>
        )}
        {actionPending && !busy && !pending && (
          <p className="settings-hint" role="status">
            正在完成先前的设置操作，请稍候再修改。
          </p>
        )}
        {section === 'general' ? (
          <section aria-label="常规设置">
            <h2>常规</h2>
            <h3>文件与模型</h3>
            <div className="settings-card">
              <label className="settings-row">
                <span>
                  <strong>默认文件打开位置</strong>
                  <small>选择打开项目文件的应用；本次运行期间生效</small>
                </span>
                <select
                  aria-label="默认编辑器"
                  value={editor}
                  onChange={(event) => onEditorChange(event.target.value as typeof editor)}
                >
                  <option value="vscode">VS Code</option>
                  <option value="zed">Zed</option>
                  <option value="textedit">TextEdit</option>
                </select>
              </label>
              <div className="settings-row">
                <span>
                  <strong>当前默认模型</strong>
                  <small>更改模型与 Provider 请前往对应分类</small>
                </span>
                <span className="settings-value">
                  {view.models?.selected
                    ? `${view.models.selected.provider} · ${view.models.selected.name}`
                    : '尚未选择'}
                </span>
              </div>
            </div>
          </section>
        ) : section === 'providers' ? (
          <section aria-label="提供商设置" className="settings-models">
            <h2>提供商</h2>
            <p className="settings-models-description">连接模型服务，管理你的 API 与本地模型。</p>
            <div className="settings-card settings-provider-list">
              {providerOptions.map((option) => {
                const configured =
                  view.models?.providers.filter((item) => item.type === option.type) ?? [];
                const ready = configured.some((item) => item.readiness === 'ready');
                return (
                  <div className="settings-row" key={option.type}>
                    <span>
                      <strong>{option.label}</strong>
                      <small>{option.description}</small>
                    </span>
                    <span className="settings-provider-action">
                      {configured[0] && (
                        <small>{ready ? '可用' : readinessLabel[configured[0].readiness]}</small>
                      )}
                      <button
                        type="button"
                        aria-expanded={editingProvider && provider === option.type}
                        aria-controls="provider-config-panel"
                        aria-disabled={actionBlocked || undefined}
                        onClick={(event) => {
                          if (actionBlocked) return;
                          providerButton.current = event.currentTarget;
                          setProvider(option.type);
                          setEditingProvider(true);
                          setSaved(false);
                          setFormErrors({});
                          if (keyInput.current) keyInput.current.value = '';
                        }}
                      >
                        {configured.length > 0 ? '编辑' : '配置'}
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
        ) : section === 'models' ? (
          <section aria-label="模型设置" className="settings-models">
            <div className="settings-models-title">
              <div>
                <h2>模型</h2>
                <p className="settings-models-description">选择默认模型，管理任务中可用的模型。</p>
              </div>
              <button
                type="button"
                disabled={busy || !view.connected}
                aria-busy={pending?.type === 'refresh'}
                aria-disabled={actionBlocked || undefined}
                onClick={() => runModelAction({ type: 'refresh' }, () => client.refreshModels())}
              >
                刷新配置
              </button>
            </div>
            <div className="settings-card settings-model-current">
              <div className="settings-row">
                <span>
                  <strong>默认模型</strong>
                  <small>用于后续执行，正在运行的任务不受影响</small>
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      className="settings-model-trigger"
                      aria-label="默认模型"
                      aria-busy={pending?.type === 'select'}
                      aria-disabled={actionBlocked || undefined}
                      disabled={busy || !view.connected || selectableModels.length === 0}
                      onPointerDown={(event) => {
                        if (actionBlocked) event.preventDefault();
                      }}
                      onKeyDown={(event) => {
                        if (actionBlocked && ['Enter', ' ', 'ArrowDown'].includes(event.key))
                          event.preventDefault();
                      }}
                    >
                      <span>
                        {selectedModelAvailable && view.models?.selected
                          ? `${view.models.selected.provider} · ${view.models.selected.name}`
                          : selectableModels.length
                            ? '选择模型'
                            : '暂无可用模型'}
                      </span>
                      <HugeiconsIcon
                        icon={ArrowDown01Icon}
                        data-icon="inline-end"
                        aria-hidden="true"
                      />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    className="model-menu settings-model-menu"
                    portalled={false}
                    align="end"
                    sideOffset={6}
                    aria-label="选择默认模型"
                  >
                    <DropdownMenuRadioGroup
                      value={selectedModelAvailable ? selectedModelValue : ''}
                    >
                      {[...new Set(selectableModels.map((model) => model.provider))].map(
                        (provider) => (
                          <DropdownMenuGroup key={provider}>
                            <DropdownMenuLabel className="model-provider-label">
                              {provider}
                            </DropdownMenuLabel>
                            {selectableModels
                              .filter((model) => model.provider === provider)
                              .map((model) => (
                                <DropdownMenuRadioItem
                                  key={JSON.stringify([model.provider, model.name])}
                                  value={JSON.stringify([model.provider, model.name])}
                                  indicatorPosition="end"
                                  disabled={actionBlocked || !view.connected}
                                  onSelect={() =>
                                    runModelAction({ type: 'select' }, () =>
                                      client.selectModel(model.provider, model.name),
                                    )
                                  }
                                >
                                  {model.name}
                                </DropdownMenuRadioItem>
                              ))}
                          </DropdownMenuGroup>
                        ),
                      )}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            <div className="settings-model-section-heading">
              <h3>模型列表</h3>
              <span>开启后显示在任务的模型列表中</span>
            </div>
            <div className="model-list">
              {view.models?.providers.map((item) => (
                <div className="settings-model-provider" key={item.provider}>
                  <div className="settings-model-provider-heading">
                    <div className="settings-model-provider-identity">
                      <strong>{item.provider}</strong>
                      <span>
                        {providerLabel[item.type]} · {item.models.length} 个模型
                      </span>
                    </div>
                    <span className="settings-model-status" data-readiness={item.readiness}>
                      {readinessLabel[item.readiness]}
                    </span>
                  </div>
                  {item.models.length > 0 ? (
                    <div className="settings-model-options">
                      {item.models.map((model) => {
                        const selected =
                          view.models?.selected?.provider === item.provider &&
                          view.models.selected.name === model.name;
                        const updating =
                          pending?.type === 'enabled' &&
                          pending.provider === item.provider &&
                          pending.name === model.name;
                        const enabled = updating ? pending.enabled : model.enabled !== false;
                        return (
                          <label
                            className="settings-model-option"
                            key={model.name}
                            data-enabled={enabled}
                          >
                            <span>
                              <strong>{model.name}</strong>
                              {selected && (
                                <small className="settings-model-default-badge">默认</small>
                              )}
                            </span>
                            <input
                              type="checkbox"
                              role="switch"
                              aria-label={`启用 ${item.provider} ${model.name}`}
                              title={
                                selected ? '默认模型不能禁用，请先选择另一默认模型' : undefined
                              }
                              aria-checked={enabled}
                              checked={enabled}
                              aria-busy={updating}
                              aria-disabled={actionBlocked || undefined}
                              disabled={
                                busy || !view.connected || (selected && model.enabled !== false)
                              }
                              onChange={(event) => {
                                if (actionBlocked) return;
                                const enabled = event.currentTarget.checked;
                                runModelAction(
                                  {
                                    type: 'enabled',
                                    provider: item.provider,
                                    name: model.name,
                                    enabled,
                                  },
                                  () => client.setModelEnabled(item.provider, model.name, enabled),
                                );
                              }}
                            />
                          </label>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="settings-model-empty">暂无可选模型，请检查“提供商”配置。</p>
                  )}
                  {item.diagnosticCode && (
                    <p className="settings-model-diagnostic">诊断：{item.diagnosticCode}</p>
                  )}
                </div>
              ))}
              {!view.models && <p className="settings-model-empty">模型配置尚未载入。</p>}
              {view.models?.providers.length === 0 && (
                <p className="settings-model-empty">尚无 Provider 配置，请前往“提供商”连接。</p>
              )}
            </div>
          </section>
        ) : (
          <Extensions
            client={client}
            view={view}
            busy={actionBlocked}
            act={act}
            section={section}
          />
        )}
      </div>
      {editingProvider && section === 'providers' && (
        <div className="settings-provider-panel">
          <RightSidebar
            id="provider-config-panel"
            label={`${providerLabel[provider]} 配置`}
            title={`${providerLabel[provider]} 配置`}
            onClose={closeProvider}
          >
            <form
              key={provider}
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                if (actionBlocked || !view.connected) return;
                const data = new FormData(event.currentTarget);
                const apiKey = keyInput.current?.value.trim() ?? '';
                const baseURL = String(data.get('baseURL') ?? '').trim();
                const errors: { apiKey?: string; baseURL?: string } = {};
                if ((provider === 'openai' || provider === 'deepseek') && !apiKey) {
                  errors.apiKey = '请输入 API key';
                }
                if (baseURL) {
                  try {
                    const url = new URL(baseURL);
                    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
                      errors.baseURL = '请输入以 http:// 或 https:// 开头的地址';
                    }
                  } catch {
                    errors.baseURL = '请输入有效的服务地址';
                  }
                }
                setFormErrors(errors);
                if (errors.apiKey) {
                  keyInput.current?.focus();
                  return;
                }
                if (errors.baseURL) {
                  baseURLInput.current?.focus();
                  return;
                }
                const input = {
                  provider,
                  apiKey,
                  baseURL,
                  modelName: String(data.get('modelName') ?? ''),
                };
                if (keyInput.current) keyInput.current.value = '';
                setSaved(false);
                runModelAction({ type: 'provider' }, async () => {
                  await client.configureProvider(input);
                  setSaved(true);
                });
              }}
            >
              <fieldset
                className="settings-provider-form"
                disabled={busy || !view.connected}
                aria-label={`${providerLabel[provider]} 配置表单`}
                aria-busy={pending?.type === 'provider'}
              >
                <p className="settings-provider-intro">
                  配置保存在本机用户 kite-code.jsonc；API key 不会在此回显。
                </p>
                <label>
                  API key
                  <input
                    ref={keyInput}
                    readOnly={actionBlocked}
                    type="password"
                    autoComplete="off"
                    maxLength={16384}
                    aria-invalid={Boolean(formErrors.apiKey)}
                    aria-describedby={formErrors.apiKey ? 'provider-key-error' : undefined}
                    onChange={() => setFormErrors((current) => ({ ...current, apiKey: undefined }))}
                  />
                  {formErrors.apiKey && (
                    <small id="provider-key-error" role="alert">
                      {formErrors.apiKey}
                    </small>
                  )}
                </label>
                <label>
                  服务地址（留空使用默认地址）
                  <input
                    ref={baseURLInput}
                    readOnly={actionBlocked}
                    name="baseURL"
                    type="text"
                    inputMode="url"
                    maxLength={512}
                    placeholder="https://…"
                    aria-invalid={Boolean(formErrors.baseURL)}
                    aria-describedby={formErrors.baseURL ? 'provider-url-error' : undefined}
                    onChange={() =>
                      setFormErrors((current) => ({ ...current, baseURL: undefined }))
                    }
                  />
                  {formErrors.baseURL && (
                    <small id="provider-url-error" role="alert">
                      {formErrors.baseURL}
                    </small>
                  )}
                </label>
                <label>
                  模型名称（可选）
                  <input name="modelName" maxLength={256} readOnly={actionBlocked} />
                </label>
                <p>
                  留空模型名称会查询模型列表；填写名称则直接保存，不验证该模型能否执行。保存会替换此
                  Provider 的现有配置。
                </p>
                <button
                  type="submit"
                  aria-disabled={actionBlocked || undefined}
                  aria-busy={pending?.type === 'provider'}
                >
                  保存 Provider
                </button>
                {saved && (
                  <p role="status">
                    已保存并刷新配置。请到“模型”分类点击模型（即使已选中）使后续执行使用最新配置。
                  </p>
                )}
              </fieldset>
            </form>
          </RightSidebar>
        </div>
      )}
    </div>
  );
}
