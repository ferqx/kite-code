import type { AppModelProviderType } from '@kite-ai/kite-app-contract';
import { Button } from '@kite-ai/kite-client-ui';
import { useRef, useState } from 'react';
import type { DesktopClient, DesktopView } from './client';
import { Extensions } from './Extensions';

export function Settings({
  client,
  view,
  busy,
  act,
  editor,
  onEditorChange,
}: {
  editor: 'vscode' | 'zed' | 'textedit';
  onEditorChange: (editor: 'vscode' | 'zed' | 'textedit') => void;
  client: DesktopClient;
  view: DesktopView;
  busy: boolean;
  act: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [section, setSection] = useState<'models' | 'mcp' | 'skills'>('models');
  const [provider, setProvider] = useState<AppModelProviderType>('openai');
  const [saved, setSaved] = useState(false);
  const keyInput = useRef<HTMLInputElement>(null);
  return (
    <div className="settings settings-layout">
      <nav aria-label="设置分类">
        <Button aria-pressed={section === 'models'} onClick={() => setSection('models')}>
          模型与 Provider
        </Button>
        <Button aria-pressed={section === 'mcp'} onClick={() => setSection('mcp')}>
          MCP
        </Button>
        <Button aria-pressed={section === 'skills'} onClick={() => setSection('skills')}>
          Skills
        </Button>
      </nav>
      <div className="settings-content">
        {view.error && (
          <p className="notice error" role="alert">
            {view.error}
          </p>
        )}
        {section === 'models' ? (
          <section aria-label="模型与 Provider 设置">
            <h2>模型与 Provider</h2>
            <label>
              默认编辑器
              <select
                aria-label="默认编辑器"
                value={editor}
                onChange={(event) => onEditorChange(event.target.value as typeof editor)}
              >
                <option value="vscode">Visual Studio Code</option>
                <option value="zed">Zed</option>
                <option value="textedit">TextEdit</option>
              </select>
            </label>
            <p>
              配置保存在本机用户 kite-code.jsonc，API key
              随配置保存；不会回显到此界面。新模型用于后续执行，当前任务不变。
            </p>
            <button
              type="button"
              disabled={busy || !view.connected}
              onClick={() => void act(() => client.refreshModels())}
            >
              刷新配置
            </button>
            <div className="model-list">
              {view.models?.providers.map((item) => (
                <fieldset key={item.provider} disabled={busy || !view.connected}>
                  <legend>
                    {item.provider} · {item.readiness}
                  </legend>
                  {item.models.map((model) => (
                    <button
                      type="button"
                      key={model.name}
                      aria-pressed={
                        view.models?.selected?.provider === item.provider &&
                        view.models.selected.name === model.name
                      }
                      onClick={() => void act(() => client.selectModel(item.provider, model.name))}
                    >
                      {model.name}
                      {view.models?.selected?.provider === item.provider &&
                      view.models.selected.name === model.name
                        ? ' ✓'
                        : ''}
                    </button>
                  ))}
                  {item.diagnosticCode && <p>{item.diagnosticCode}</p>}
                </fieldset>
              ))}
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (busy) return;
                const data = new FormData(event.currentTarget);
                const input = {
                  provider,
                  apiKey: keyInput.current?.value ?? '',
                  baseURL: String(data.get('baseURL') ?? ''),
                  modelName: String(data.get('modelName') ?? ''),
                };
                if (keyInput.current) keyInput.current.value = '';
                setSaved(false);
                void act(async () => {
                  await client.configureProvider(input);
                  setSaved(true);
                });
              }}
            >
              <fieldset disabled={busy || !view.connected}>
                <legend>添加或替换 Provider 配置</legend>
                <label>
                  Provider
                  <select
                    value={provider}
                    onChange={(event) => {
                      setProvider(event.target.value as AppModelProviderType);
                      setSaved(false);
                      if (keyInput.current) keyInput.current.value = '';
                    }}
                  >
                    <option value="openai">OpenAI</option>
                    <option value="deepseek">DeepSeek</option>
                    <option value="openai-compatible">OpenAI-compatible</option>
                    <option value="ollama">Ollama</option>
                  </select>
                </label>
                <label>
                  API key
                  <input
                    ref={keyInput}
                    type="password"
                    autoComplete="off"
                    maxLength={16384}
                    required={provider === 'openai' || provider === 'deepseek'}
                  />
                </label>
                <label>
                  服务地址（留空使用默认地址）
                  <input name="baseURL" type="url" maxLength={512} placeholder="https://…" />
                </label>
                <label>
                  模型名称（可选）
                  <input name="modelName" maxLength={256} />
                </label>
                <p>
                  留空模型名称会查询模型列表；填写名称则直接保存，不验证该模型能否执行。保存会替换此
                  Provider 的现有配置。
                </p>
                <button type="submit">{busy ? '处理中…' : '保存 Provider'}</button>
                {saved && (
                  <p role="status">
                    已保存并刷新配置。请点击模型（即使已选中）使后续执行使用最新配置。
                  </p>
                )}
              </fieldset>
            </form>
          </section>
        ) : (
          <Extensions client={client} view={view} busy={busy} act={act} section={section} />
        )}
      </div>
    </div>
  );
}
