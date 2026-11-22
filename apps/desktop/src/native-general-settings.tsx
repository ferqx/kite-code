import { useId } from 'react';
import type { DesktopEditor } from './file-changes-bridge';
import type { NativeSettingsRequestPort } from './native-bridge';
import { NativeSettingsHeading } from './native-settings-heading';
import { NativeSettingsSelect } from './native-settings-select';
import { NativeShellSettings } from './native-shell-settings';

export function NativeGeneralSettings({
  bridge,
  generation,
  storeId,
  editor,
  onEditorChange,
  windowsShell,
}: {
  bridge: NativeSettingsRequestPort;
  generation: number;
  storeId?: string;
  editor: DesktopEditor;
  onEditorChange: (editor: DesktopEditor) => void;
  windowsShell?: boolean;
}) {
  const fieldId = useId();
  return (
    <section className="general-settings" aria-label="常规设置">
      <NativeSettingsHeading
        title="常规"
        description={windowsShell ? '管理文件打开方式和集成终端。' : '管理文件打开方式。'}
      />
      <h3 className="settings-group-heading">{windowsShell ? '文件与终端' : '文件'}</h3>
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
        {windowsShell && (
          <NativeShellSettings
            key={`${generation}:${storeId}`}
            bridge={bridge}
            generation={generation}
            storeId={storeId}
          />
        )}
      </div>
    </section>
  );
}
