import { useEffect, useId, useState } from 'react';
import type { DesktopEditor } from './file-changes-bridge';
import type { NativeBridge, NativeModelSettingsFacts, NativeSelection } from './native-bridge';
import { NativeSettingsSelect } from './native-settings-select';
import { NativeShellSettings } from './native-shell-settings';

/** Retained General card; reads the configuration default, not a temporary next-Run choice. */
export function NativeGeneralSettings({
  bridge,
  generation,
  storeId,
  selection,
  revision,
  editor,
  onEditorChange,
  windowsShell,
}: {
  bridge: NativeBridge;
  generation: number;
  storeId?: string;
  selection?: NativeSelection;
  revision: number;
  editor: DesktopEditor;
  onEditorChange: (editor: DesktopEditor) => void;
  windowsShell?: boolean;
}) {
  const fieldId = useId();
  const identity = JSON.stringify([
    generation,
    storeId,
    selection?.session.id,
    selection?.viewSelection,
    selection?.session.workspaceId,
    revision,
  ]);
  const [state, setState] = useState<{
    identity: string;
    facts?: NativeModelSettingsFacts;
    error?: string;
  }>({ identity });
  useEffect(() => {
    let active = true;
    setState({ identity });
    void bridge
      .request({
        method: 'settings.general.models.read',
        generation,
      })
      .then((value) => {
        if (!active) return;
        if (
          !value ||
          !('models' in value) ||
          !('kind' in value) ||
          value.kind !== 'settings.models' ||
          value.storeId !== storeId ||
          value.scope !== 'user' ||
          value.workspaceId !== undefined
        )
          throw Error('configuration_scope_mismatch');
        setState({ identity, facts: value });
      })
      .catch(() => {
        if (active) setState({ identity, error: '当前默认模型不可读，请重新打开常规设置。' });
      });
    return () => {
      active = false;
      void bridge.request({ method: 'settings.general.models.close', generation }).catch(() => {});
    };
  }, [bridge, identity, generation, storeId]);
  const facts = state.identity === identity ? state.facts : undefined;
  const model = facts?.models.find((model) => model.id === facts.defaultModelId);
  return (
    <section
      className="general-settings"
      aria-label="常规设置"
      aria-busy={(!facts && !(state.identity === identity && state.error)) || undefined}
    >
      <header className="settings-page-heading">
        <div>
          <h2>常规</h2>
          <p>
            {windowsShell
              ? '管理文件打开方式和集成终端，查看当前默认模型。'
              : '管理文件打开方式，查看当前默认模型。'}
          </p>
        </div>
      </header>
      <h3 className="settings-group-heading">{windowsShell ? '文件、模型与终端' : '文件与模型'}</h3>
      <div className="settings-card">
        <label className="settings-row" htmlFor={`${fieldId}-field-1`}>
          <span>
            <strong>默认文件打开位置</strong>
            <small>选择打开项目文件的应用；本次运行期间生效</small>
          </span>
          <NativeSettingsSelect
            id={`${fieldId}-field-1`}
            aria-label="默认编辑器"
            value={editor}
            onValueChange={(value) => onEditorChange(value as DesktopEditor)}
            options={[
              { value: 'vscode', label: 'VS Code' },
              { value: 'zed', label: 'Zed' },
              { value: 'textedit', label: 'TextEdit' },
            ]}
          />
        </label>
        <div className="settings-row">
          <span>
            <strong>当前默认模型</strong>
            <small>
              模型启停与连接配置请前往“提供商与模型”；全局默认请在 ~/.kite-code/kite-code.jsonc
              中修改。
            </small>
          </span>
          <span className="settings-value">
            {facts
              ? model
                ? `${model.provider ?? '其他'} · ${model.model ?? model.id}`
                : facts.defaultModelId
                  ? `${facts.defaultModelId} · 当前不可用`
                  : '尚未选择'
              : state.identity === identity && state.error
                ? '读取失败'
                : ''}
          </span>
        </div>
        {windowsShell && (
          <NativeShellSettings
            key={`${generation}:${storeId}`}
            bridge={bridge}
            generation={generation}
            storeId={storeId}
          />
        )}
      </div>
      {state.identity === identity && state.error && <p role="alert">{state.error}</p>}
      {facts?.errors.map((code) => (
        <p role="alert" key={code}>
          模型配置不可用：{code}
        </p>
      ))}
    </section>
  );
}
