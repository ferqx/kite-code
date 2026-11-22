import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  ErrorFeedbackContext,
} from '@kite-ai/ui/desktop';
import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import type { DesktopEditor } from './file-changes-bridge';
import type { NativeSettingsEditorControl, NativeSettingsRequestPort } from './native-bridge';
import { useNativeErrorFeedback } from './native-error-feedback';
import { NativeGeneralSettings } from './native-general-settings';
import { NativeMcpSettings } from './native-mcp-settings';
import { NativeToast } from './native-message';
import { NativeProviderModelSettings } from './native-provider-model-settings';
import type { NativeSettingsState } from './native-settings-bridge';
import { NativeSettingsHeading } from './native-settings-heading';
import { NativeSettingsLayout, type NativeSettingsPage } from './native-settings-layout';
import { NativeSettingsSelect } from './native-settings-select';
import { NativeSkillsSettings } from './native-skills-settings';
import type { ThemePreference } from './native-theme';
import { NativeTraceSettings } from './native-trace-settings';
import { NativeBoundWebSearchSettings } from './native-web-search-settings';
import './native-settings-workspace.css';

export function NativeSettingsWorkspace({
  bridge,
  state,
  onClose,
  onEditorChange,
  onThemeChange,
  onSaved,
  retentionKey,
}: {
  bridge: NativeSettingsRequestPort;
  state: NativeSettingsState;
  onClose(): void;
  onEditorChange(editor: DesktopEditor): void;
  onThemeChange(theme: ThemePreference): void;
  onSaved(): void;
  retentionKey?: object;
}) {
  const [page, setPage] = useState<NativeSettingsPage>('general');
  const appearanceId = useId();
  const [editorHost, setEditorHost] = useState<HTMLDivElement | null>(null);
  const [toastHost, setToastHost] = useState<HTMLDivElement | null>(null);
  const [discard, setDiscard] = useState<(() => void) | null>(null);
  const editorControl = useRef<NativeSettingsEditorControl | null>(null);
  const discardCancel = useRef<HTMLButtonElement>(null);
  const { generation, storeId, selection } = state;
  const feedback = useNativeErrorFeedback(
    JSON.stringify([state.instanceId, generation, storeId, page]),
  );
  const scope = JSON.stringify([state.instanceId, generation, storeId, page]);
  const modelWriting = useRef(false);
  const deferredNavigation = useRef<(() => void) | null>(null);
  const onModelWritingChange = useCallback((writing: boolean) => {
    modelWriting.current = writing;
    if (!writing && deferredNavigation.current) {
      const navigate = deferredNavigation.current;
      deferredNavigation.current = null;
      queueMicrotask(navigate);
    }
  }, []);
  const scopeOwner = useRef(scope);
  useLayoutEffect(() => {
    scopeOwner.current = scope;
    return () => {
      scopeOwner.current = '';
    };
  }, [scope]);
  const guard = (proceed: () => void) => {
    const editor = editorControl.current;
    const act = () => {
      if (scopeOwner.current !== scope || editorControl.current !== editor) return;
      if (editor?.hasUnsavedChanges?.()) {
        setDiscard(() => () => {
          if (scopeOwner.current === scope && editorControl.current === editor) proceed();
        });
      } else proceed();
    };
    // A user can queue several model toggles while the first write is in flight.
    // Keep the instance-owned request port until its active writes have drained.
    if (modelWriting.current) deferredNavigation.current = act;
    else act();
  };
  const closeEditor = () => guard(() => editorControl.current?.close());
  const closeSettings = () => guard(onClose);
  const changePage = (value: NativeSettingsPage) =>
    guard(() => {
      editorControl.current?.close();
      setPage(value);
    });
  return (
    <ErrorFeedbackContext.Provider value={feedback.report}>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !discard) closeSettings();
        }}
      >
        <div className="native-settings-backdrop" aria-hidden="true" />
        <DialogContent
          className="kite-client desktop-settings-dialog native-settings-floating"
          ref={setToastHost}
          showOverlay={false}
          showCloseButton={false}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            if (discard) {
              event.preventDefault();
              return;
            }
            if (editorControl.current) {
              event.preventDefault();
              closeEditor();
            }
          }}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogTitle className="sr-only">设置</DialogTitle>
          <DialogDescription className="sr-only">配置模型、提供商与扩展能力</DialogDescription>
          <NativeSettingsLayout
            page={page}
            onPageChange={changePage}
            canReadWebSearch={state.canReadWebSearch}
            onClose={closeSettings}
            onEditorBack={closeEditor}
            setEditorHost={setEditorHost}
          >
            {page === 'general' ? (
              <NativeGeneralSettings
                bridge={bridge}
                generation={generation}
                storeId={storeId}
                editor={state.editor}
                onEditorChange={onEditorChange}
                windowsShell={state.windowsShell}
              />
            ) : page === 'appearance' ? (
              <section className="general-settings" aria-label="外观设置">
                <NativeSettingsHeading title="外观" description="选择 Kite 的显示主题。" />
                <div className="settings-card">
                  <label className="settings-row" htmlFor={appearanceId}>
                    <span>
                      <strong>外观</strong>
                    </span>
                    <NativeSettingsSelect
                      aria-label="外观"
                      id={appearanceId}
                      value={state.appearance}
                      onValueChange={(value) => onThemeChange(value as ThemePreference)}
                      options={[
                        { value: 'system', label: '跟随系统' },
                        { value: 'light', label: '浅色' },
                        { value: 'dark', label: '深色' },
                      ]}
                    />
                  </label>
                </div>
              </section>
            ) : page === 'webSearch' ? (
              state.canReadWebSearch && storeId ? (
                <NativeBoundWebSearchSettings
                  onManageProviders={() => changePage('providers')}
                  bridge={bridge}
                  generation={generation}
                  storeId={storeId}
                  sessionId={state.webSearchSessionId}
                />
              ) : (
                <section className="general-settings" aria-label="网页搜索设置">
                  <NativeSettingsHeading
                    title="网页搜索"
                    description="跟随模型与提供商，无需单独配置。"
                  />
                  <p role="status">当前连接不支持网页搜索设置。</p>
                </section>
              )
            ) : page === 'trace' ? (
              storeId ? (
                <NativeTraceSettings
                  bridge={bridge}
                  generation={generation}
                  storeId={storeId}
                  selection={selection}
                />
              ) : (
                <section className="general-settings" aria-label="Trace 设置">
                  <NativeSettingsHeading title="轨迹与集成" description="管理执行轨迹的导出。" />
                  <p role="status">连接可用的本机数据后管理轨迹集成。</p>
                </section>
              )
            ) : page === 'skills' ? (
              <NativeSkillsSettings
                panelHost={editorHost}
                editorControl={editorControl}
                bridge={bridge}
                generation={generation}
                storeId={storeId}
              />
            ) : page === 'mcp' ? (
              <NativeMcpSettings
                panelHost={editorHost}
                editorControl={editorControl}
                onRequestEditorClose={closeEditor}
                bridge={bridge}
                generation={generation}
                storeId={storeId}
                submissions={state.userMcpSubmissions ?? []}
              />
            ) : (
              <NativeProviderModelSettings
                key={JSON.stringify([
                  generation,
                  storeId,
                  selection?.session.id,
                  selection?.viewSelection,
                ])}
                panelHost={editorHost}
                toastHost={toastHost}
                editorControl={editorControl}
                onRequestEditorClose={closeEditor}
                bridge={bridge}
                generation={generation}
                selection={selection}
                storeId={storeId}
                providerSubmissions={state.providerSubmissions ?? []}
                modelSubmissions={state.modelSubmissions ?? []}
                onSaved={onSaved}
                retentionKey={retentionKey}
                onModelWritingChange={onModelWritingChange}
              />
            )}
          </NativeSettingsLayout>
          <NativeToast
            container={toastHost ?? undefined}
            message={feedback.message}
            onDismiss={feedback.dismiss}
          />
          <Dialog
            open={!!discard}
            onOpenChange={(open) => {
              if (!open) setDiscard(null);
            }}
          >
            <DialogContent
              className="kite-client native-settings-discard"
              showCloseButton={false}
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                discardCancel.current?.focus();
              }}
              onInteractOutside={(event) => event.preventDefault()}
            >
              <DialogTitle>放弃未保存的修改？</DialogTitle>
              <DialogDescription>当前表单的更改还没有保存。</DialogDescription>
              <div className="native-settings-discard-actions">
                <Button ref={discardCancel} variant="outline" onClick={() => setDiscard(null)}>
                  继续编辑
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    const proceed = discard;
                    setDiscard(null);
                    proceed?.();
                  }}
                >
                  放弃更改
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </DialogContent>
      </Dialog>
    </ErrorFeedbackContext.Provider>
  );
}
