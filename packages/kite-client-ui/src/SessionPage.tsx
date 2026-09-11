import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Composer, type ComposerProps } from './Composer';
import { Conversation, type ReadingState } from './Conversation';
import { FileChanges } from './FileChanges';
import {
  NewConversationContext,
  type NewConversationProps,
  NewConversationWelcome,
} from './NewConversation';
import { type PageActions, Sidebar } from './Sidebar';
import type { Message, WorkspaceSummary } from './types';
import { Button } from './ui';

const collapseSidebarIcon = new URL('./assets/sidebar-collapse.svg', import.meta.url).href;
const expandSidebarIcon = new URL('./assets/sidebar-expand.svg', import.meta.url).href;

export interface SessionPageProps {
  workspaces: readonly WorkspaceSummary[];
  selected?: string;
  workspaceLabel: string;
  sessionLabel: string;
  readingKey: string;
  messages: readonly Message[];
  loading: boolean;
  connected: boolean;
  connectionLabel: string;
  busy?: boolean;
  actions: PageActions;
  onOpen?: (id: string) => void;
  onExpand?: (id: string) => void;
  defaultExpanded?: boolean;
  onLoadMore?: () => void;
  composer?: ComposerProps;
  readOnlyReason?: string;
  notices?: ReactNode;
  headerActions?: ReactNode;
  interaction?: ReactNode;
  beforeConversation?: ReactNode;
  diagnosticView?: ReactNode;
  historyPanel?: { id: string; labelledBy: string };
  historyError?: { title: string; detail: string; retry: () => void };
  overlays?: ReactNode;
  fileChanges?: readonly Message[];
  newConversation?: NewConversationProps;
}

/** The single production conversation page for both hosts. No host/protocol imports. */
export function SessionPage(props: SessionPageProps) {
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const focusComposerOnClose = useRef(false);
  const [narrow, setNarrow] = useState(
    () => typeof matchMedia !== 'undefined' && matchMedia('(max-width: 600px)').matches,
  );
  const [sidebarOpen, setSidebarOpen] = useState(!narrow);
  const [changesKey, setChangesKey] = useState<string>();
  const changesOpen = changesKey === props.readingKey && props.fileChanges !== undefined;
  const changesToggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (changesKey !== undefined && changesKey !== props.readingKey) setChangesKey(undefined);
  }, [changesKey, props.readingKey]);
  const readings = useRef<Record<string, ReadingState>>({});
  const sidebar = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        document.querySelector('dialog[open]') ||
        [...document.querySelectorAll('[role="dialog"]')].some(
          (element) => element !== sidebar.current,
        )
      )
        return;
      if (narrow && sidebarOpen) {
        setSidebarOpen(false);
        toggle.current?.focus();
        return;
      }
      if (changesOpen) {
        setChangesKey(undefined);
        changesToggle.current?.focus();
        return;
      }
      if (narrow) {
        setSidebarOpen(false);
        toggle.current?.focus();
      }
    };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [narrow, sidebarOpen, changesOpen]);
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const media = matchMedia('(max-width: 600px)');
    const resize = () => {
      setNarrow(media.matches);
      if (media.matches) setSidebarOpen(false);
    };
    resize();
    media.addEventListener('change', resize);
    return () => media.removeEventListener('change', resize);
  }, []);
  useEffect(() => {
    if (!narrow || !sidebarOpen) return;
    sidebar.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      if (focusComposerOnClose.current) {
        focusComposerOnClose.current = false;
        composerInput.current?.focus();
      } else toggle.current?.focus();
    };
  }, [narrow, sidebarOpen]);
  const open = (id: string) => {
    if (props.busy || !props.onOpen) return;
    props.onOpen(id);
    if (narrow) setSidebarOpen(false);
  };
  return (
    <div className={`kite-client shell ${sidebarOpen ? 'sidebar-visible' : ''}`}>
      <header className="app-header" data-tauri-drag-region>
        {sidebarOpen && (
          <div className="sidebar-header" data-tauri-drag-region>
            <Button
              ref={toggle}
              className="ghost sidebar-toggle"
              size="icon-sm"
              aria-expanded={sidebarOpen}
              aria-label="收起侧栏"
              title="收起侧栏"
              onClick={() => setSidebarOpen(false)}
            >
              <img src={collapseSidebarIcon} alt="" width={16} height={16} />
            </Button>
          </div>
        )}
        <div className="session-header" data-tauri-drag-region inert={narrow && sidebarOpen}>
          {!sidebarOpen && (
            <Button
              ref={toggle}
              className="ghost sidebar-toggle"
              size="icon-sm"
              aria-expanded={sidebarOpen}
              aria-label="展开侧栏"
              title="展开侧栏"
              onClick={() => setSidebarOpen(true)}
            >
              <img src={expandSidebarIcon} alt="" width={16} height={16} />
            </Button>
          )}
          <div className="breadcrumb" data-tauri-drag-region>
            {props.newConversation ? (
              <strong>新对话</strong>
            ) : (
              <>
                <span>{props.workspaceLabel}</span>
                <span aria-hidden="true">/</span>
                <strong>{props.sessionLabel}</strong>
              </>
            )}
          </div>
          {props.headerActions}
          {props.fileChanges !== undefined && (
            <Button
              ref={changesToggle}
              className="ghost"
              aria-expanded={changesOpen}
              aria-controls="session-file-changes"
              onClick={() => setChangesKey(changesOpen ? undefined : props.readingKey)}
            >
              {changesOpen ? '收起变更' : '文件变更'}
            </Button>
          )}
        </div>
      </header>
      <aside
        ref={sidebar}
        className="sidebar"
        aria-label="空间与会话"
        hidden={!sidebarOpen}
        {...(narrow && sidebarOpen ? { role: 'dialog', 'aria-modal': true } : {})}
        onKeyDown={(event) => {
          if (!narrow || event.key !== 'Tab') return;
          const controls = [
            ...(sidebar.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), a[href]',
            ) ?? []),
          ].filter((element) => element.getClientRects().length);
          const first = controls[0];
          const last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <Sidebar
          workspaces={props.workspaces}
          selected={props.selected}
          busy={props.busy}
          actions={{
            ...props.actions,
            newWorkspaceSession: props.actions.newWorkspaceSession
              ? (id) => {
                  props.actions.newWorkspaceSession?.(id);
                  if (narrow) {
                    focusComposerOnClose.current = true;
                    setSidebarOpen(false);
                  }
                  composerInput.current?.focus();
                }
              : undefined,
            newSession: props.actions.newSession
              ? () => {
                  props.actions.newSession?.();
                  if (narrow) {
                    focusComposerOnClose.current = true;
                    setSidebarOpen(false);
                  }
                  composerInput.current?.focus();
                }
              : undefined,
          }}
          connectionLabel={props.connectionLabel}
          onExpand={props.onExpand}
          defaultExpanded={props.defaultExpanded}
          onLoadMore={props.onLoadMore}
          onOpen={props.onOpen ? open : undefined}
        />
      </aside>
      {narrow && sidebarOpen && (
        <button
          type="button"
          className="sidebar-backdrop"
          tabIndex={-1}
          aria-label="关闭空间列表"
          onClick={() => {
            setSidebarOpen(false);
            toggle.current?.focus();
          }}
        />
      )}
      <main
        className={props.newConversation ? 'new-conversation-page' : undefined}
        inert={narrow && sidebarOpen}
      >
        {props.notices}
        <div className="session-body">
          <div className="session-view">
            {props.beforeConversation}
            {props.diagnosticView ?? (
              <section
                className="history-panel"
                role={props.historyPanel ? 'tabpanel' : undefined}
                id={props.historyPanel?.id}
                aria-labelledby={props.historyPanel?.labelledBy}
              >
                {props.newConversation && props.composer ? (
                  <NewConversationWelcome
                    onSuggest={(value) => {
                      props.composer!.onChange(
                        props.composer!.draft ? `${props.composer!.draft}\n${value}` : value,
                      );
                      composerInput.current?.focus();
                    }}
                  />
                ) : props.historyError ? (
                  <section className="notice error" role="alert">
                    <strong>{props.historyError.title}</strong>
                    <p>{props.historyError.detail}</p>
                    <Button onClick={props.historyError.retry}>重试</Button>
                  </section>
                ) : (
                  <Conversation
                    key={props.readingKey}
                    messages={props.messages}
                    loading={props.loading}
                    selected={!!props.selected}
                    emptyState={
                      !props.composer
                        ? {
                            title: props.selected
                              ? '暂无消息'
                              : props.workspaces.length
                                ? '选择会话'
                                : '暂无可查看的会话',
                            detail: props.selected
                              ? '当前会话没有可展示的历史消息。'
                              : '从左侧空间中点击会话即可加载消息。',
                          }
                        : undefined
                    }
                    connected={props.connected}
                    initialReading={readings.current[props.readingKey]}
                    saveReading={(state) => {
                      readings.current[props.readingKey] = state;
                    }}
                    openFile={props.actions.openFile}
                  />
                )}
              </section>
            )}
            <footer className="conversation-footer">
              <div className="bottom-controls">
                {props.interaction && <div className="interaction-area">{props.interaction}</div>}
                {props.composer ? (
                  <Composer
                    {...props.composer}
                    inputRef={composerInput}
                    context={
                      props.newConversation && <NewConversationContext {...props.newConversation} />
                    }
                  />
                ) : (
                  props.readOnlyReason && (
                    <p className="hint" role="status">
                      {props.readOnlyReason}
                    </p>
                  )
                )}
              </div>
            </footer>
          </div>
          {changesOpen && (
            <aside className="context-panel" id="session-file-changes" aria-label="文件变更">
              <div className="context-heading">
                <h2>文件变更</h2>
                <Button
                  className="ghost"
                  onClick={() => {
                    setChangesKey(undefined);
                    changesToggle.current?.focus();
                  }}
                >
                  关闭
                </Button>
              </div>
              <FileChanges messages={props.fileChanges!} openFile={props.actions.openFile} />
            </aside>
          )}
        </div>
      </main>
      {props.overlays}
    </div>
  );
}
