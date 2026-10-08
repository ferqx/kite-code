import { useEffect, useState } from 'react';
import type { DesktopEditor } from './file-changes-bridge';
import type { NativeBridge, NativeModelSettingsFacts, NativeSelection } from './native-bridge';

/** Retained General card; reads the configuration default, not a temporary next-Run choice. */
export function NativeGeneralSettings({
  bridge,
  generation,
  storeId,
  selection,
  revision,
  editor,
  onEditorChange,
}: {
  bridge: NativeBridge;
  generation: number;
  storeId?: string;
  selection?: NativeSelection;
  revision: number;
  editor: DesktopEditor;
  onEditorChange: (editor: DesktopEditor) => void;
}) {
  const workspaceId = selection?.session.workspaceId;
  const scope = selection ? 'workspace' : 'user';
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
        method: 'settings.models.read',
        generation,
        scope,
      })
      .then((value) => {
        if (!active) return;
        if (
          !value ||
          !('models' in value) ||
          !('kind' in value) ||
          value.kind !== 'settings.models' ||
          value.storeId !== storeId ||
          value.scope !== scope ||
          value.workspaceId !== workspaceId
        )
          throw Error('configuration_scope_mismatch');
        setState({ identity, facts: value });
      })
      .catch(() => {
        if (active) setState({ identity, error: '当前默认模型不可读，请重新打开常规设置。' });
      });
    return () => {
      active = false;
      void bridge.request({ method: 'settings.models.close', generation }).catch(() => {});
    };
  }, [bridge, identity, generation, storeId, workspaceId, scope]);
  const facts = state.identity === identity ? state.facts : undefined;
  const model = facts?.models.find((model) => model.id === facts.defaultModelId);
  return (
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
            onChange={(event) => onEditorChange(event.target.value as DesktopEditor)}
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
            {facts
              ? model
                ? `${model.provider ?? '其他'} · ${model.model ?? model.id}`
                : facts.defaultModelId
                  ? `${facts.defaultModelId} · 当前不可用`
                  : '尚未选择'
              : state.identity === identity && state.error
                ? '读取失败'
                : '正在读取'}
          </span>
        </div>
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
