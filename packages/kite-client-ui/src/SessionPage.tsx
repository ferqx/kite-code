import { PanelLeftCloseIcon, PanelLeftOpenIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Composer, type ComposerProps } from './Composer';
import { Conversation, type ReadingState } from './Conversation';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './components/ui/resizable';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from './components/ui/sheet';
import { FileChanges } from './FileChanges';
import {
  NewConversationContext,
  type NewConversationProps,
  NewConversationWelcome,
} from './NewConversation';
import { RightSidebar } from './RightSidebar';
import { ScheduledTaskEditor, ScheduledTasks, type ScheduledTasksProps } from './ScheduledTasks';
import { type PageActions, Sidebar } from './Sidebar';
import type { Message, WorkspaceSummary } from './types';
import { Button } from './ui';
import { Workbench } from './Workbench';

const SESSION_HEADER_LABEL_LIMIT = 10;

function sessionHeaderLabel(label: string): string {
  const characters = Array.from(label);
  if (characters.length <= SESSION_HEADER_LABEL_LIMIT) return label;
  return `${characters.slice(0, SESSION_HEADER_LABEL_LIMIT - 1).join('')}…`;
}

export interface SessionPageProps {
  workspaces: readonly WorkspaceSummary[];
  selected?: string;
  sessionLabel: string;
  readingKey: string;
  messages: readonly Message[];
  loading: boolean;
  connected: boolean;
  connectionLabel: string;
  busy?: boolean;
  mutationBusy?: boolean;
  actions: PageActions;
  onOpen?: (id: string) => void;
  onExpand?: (id: string) => void;
  defaultExpanded?: boolean;
  composer?: ComposerProps;
  readOnlyReason?: string;
  notices?: ReactNode;
  headerActions?: ReactNode;
  onHeaderMouseDown?: (clickCount: 1 | 2) => void;
  interaction?: ReactNode;
  beforeConversation?: ReactNode;
  diagnosticView?: ReactNode;
  historyPanel?: { id: string; labelledBy: string };
  historyError?: { title: string; detail: string; retry: () => void };
  overlays?: ReactNode;
  fileChanges?: readonly Message[];
  newConversation?: NewConversationProps;
  workbench?: boolean;
  scheduledTasks?: ScheduledTasksProps;
  writeClipboardText?: (text: string) => Promise<void>;
}

/** The single production conversation page for both hosts. No host/protocol imports. */
export function SessionPage({ messages, fileChanges, ...props }: SessionPageProps) {
  // Keep evictable history outside props captured by persistent window listeners.
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const focusComposerAfterCommit = useCallback(() => {
    if (typeof requestAnimationFrame === 'function')
      requestAnimationFrame(() => composerInput.current?.focus());
    else queueMicrotask(() => composerInput.current?.focus());
  }, []);
  const focusComposerOnClose = useRef(false);
  const [narrow, setNarrow] = useState(
    () => typeof matchMedia !== 'undefined' && matchMedia('(max-width: 600px)').matches,
  );
  const [sidebarOpen, setSidebarOpen] = useState(!narrow);
  const [changesKey, setChangesKey] = useState<string>();
  const changesOpen = changesKey === props.readingKey && fileChanges !== undefined;
  const [scheduledEditorOpen, setScheduledEditorOpen] = useState(false);
  const rightSidebarOpen = changesOpen || (scheduledEditorOpen && !!props.scheduledTasks);
  const changesToggle = useRef<HTMLButtonElement>(null);
  const scheduledEditorToggle = useRef<HTMLButtonElement | null>(null);
  const focusControlAfterCommit = useCallback((control: { current: HTMLButtonElement | null }) => {
    queueMicrotask(() => control.current?.focus());
  }, []);
  useEffect(() => {
    if (changesKey !== undefined && changesKey !== props.readingKey) setChangesKey(undefined);
  }, [changesKey, props.readingKey]);
  useEffect(() => {
    if (!props.scheduledTasks) setScheduledEditorOpen(false);
  }, [props.scheduledTasks]);
  const readings = useRef<Record<string, ReadingState>>({});
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        document.querySelector('dialog[open]') ||
        document.querySelector('[role="dialog"]')
      )
        return;
      if (rightSidebarOpen) {
        setChangesKey(undefined);
        setScheduledEditorOpen(false);
        focusControlAfterCommit(changesOpen ? changesToggle : scheduledEditorToggle);
        return;
      }
      if (narrow) {
        setSidebarOpen(false);
        toggle.current?.focus();
      }
    };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [narrow, changesOpen, rightSidebarOpen, focusControlAfterCommit]);
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
  const open = (id: string) => {
    if (!props.onOpen) return;
    props.onOpen(id);
    if (narrow) setSidebarOpen(false);
  };
  const handleHeaderMouseDown = (event: React.MouseEvent<HTMLElement>) => {
    if (
      event.button !== 0 ||
      (event.detail !== 1 && event.detail !== 2) ||
      (event.target as HTMLElement).closest(
        'button, a, input, select, textarea, label, summary, [role="button"], [role="link"]',
      )
    )
      return;
    event.preventDefault();
    props.onHeaderMouseDown?.(event.detail);
  };
  const sidebarPanel = (
    <div className={`client-sidebar-panel ${narrow ? 'narrow' : ''}`}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Desktop uses the header surface for native window dragging. */}
      <header className="sidebar-header" onMouseDown={handleHeaderMouseDown}>
        <strong className="brand">kite</strong>
        <Button
          ref={toggle}
          className="ghost sidebar-toggle"
          size="icon-sm"
          aria-expanded={sidebarOpen}
          aria-label="收起侧栏"
          title="收起侧栏"
          onClick={() => setSidebarOpen(false)}
        >
          <HugeiconsIcon icon={PanelLeftCloseIcon} />
        </Button>
      </header>
      <aside className="sidebar" aria-label="空间与会话">
        <Sidebar
          workspaces={props.workspaces}
          selected={props.selected}
          busy={props.busy}
          mutationBusy={props.mutationBusy}
          actions={{
            ...props.actions,
            newWorkspaceSession: props.actions.newWorkspaceSession
              ? (id) => {
                  props.actions.newWorkspaceSession?.(id);
                  if (narrow) {
                    focusComposerOnClose.current = true;
                    setSidebarOpen(false);
                  }
                  focusComposerAfterCommit();
                }
              : undefined,
            newSession: props.actions.newSession
              ? () => {
                  props.actions.newSession?.();
                  if (narrow) {
                    focusComposerOnClose.current = true;
                    setSidebarOpen(false);
                  }
                  focusComposerAfterCommit();
                }
              : undefined,
          }}
          connectionLabel={props.connectionLabel}
          activePage={
            props.scheduledTasks ? 'scheduledTasks' : props.workbench ? 'workbench' : 'conversation'
          }
          onExpand={props.onExpand}
          defaultExpanded={props.defaultExpanded}
          onOpen={props.onOpen ? open : undefined}
        />
      </aside>
    </div>
  );
  const rightSidebarPanel = changesOpen ? (
    <RightSidebar
      id="session-file-changes"
      label="文件变更"
      tabs={[
        {
          value: 'changes',
          label: '文件变更',
          content: <FileChanges messages={fileChanges!} openFile={props.actions.openFile} />,
        },
      ]}
      onClose={() => {
        setChangesKey(undefined);
        focusControlAfterCommit(changesToggle);
      }}
    />
  ) : scheduledEditorOpen && props.scheduledTasks ? (
    <RightSidebar
      label="新建安排任务"
      title="新建"
      onClose={() => {
        setScheduledEditorOpen(false);
        focusControlAfterCommit(scheduledEditorToggle);
      }}
    >
      <ScheduledTaskEditor
        props={props.scheduledTasks}
        onClose={() => {
          setScheduledEditorOpen(false);
          focusControlAfterCommit(scheduledEditorToggle);
        }}
      />
    </RightSidebar>
  ) : null;
  return (
    <div className={`kite-client shell ${sidebarOpen ? 'sidebar-visible' : ''}`}>
      <ResizablePanelGroup
        key={`${narrow ? 'narrow' : sidebarOpen ? 'navigation' : 'content'}-${rightSidebarOpen ? 'details' : 'plain'}`}
        id="client-layout"
        orientation="horizontal"
        className="client-panels"
      >
        {!narrow && sidebarOpen && (
          <>
            <ResizablePanel id="navigation" defaultSize="236px" minSize="200px" maxSize="420px">
              {sidebarPanel}
            </ResizablePanel>
            <ResizableHandle id="navigation-resize" withHandle />
          </>
        )}
        <ResizablePanel id="content" minSize="360px">
          <div className="client-main-panel" inert={narrow && sidebarOpen}>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: Desktop uses the header surface for native window dragging. */}
            <header className="session-header" onMouseDown={handleHeaderMouseDown}>
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
                  <HugeiconsIcon icon={PanelLeftOpenIcon} />
                </Button>
              )}
              <div className="breadcrumb">
                {props.scheduledTasks ? (
                  <strong>安排任务</strong>
                ) : props.workbench ? (
                  <strong>工作台</strong>
                ) : props.newConversation ? (
                  <strong>新对话</strong>
                ) : (
                  <strong title={props.sessionLabel}>
                    {sessionHeaderLabel(props.sessionLabel)}
                  </strong>
                )}
              </div>
              {props.headerActions}
              {fileChanges !== undefined && (
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
            </header>
            <main
              className={
                props.newConversation
                  ? 'new-conversation-page'
                  : props.scheduledTasks
                    ? 'scheduled-tasks-page'
                    : props.workbench
                      ? 'workbench-page'
                      : undefined
              }
            >
              {props.notices}
              <div className="session-body">
                <div className="session-view">
                  {props.beforeConversation}
                  {props.scheduledTasks ? (
                    <ScheduledTasks
                      {...props.scheduledTasks}
                      onNewTask={(trigger) => {
                        scheduledEditorToggle.current = trigger;
                        setScheduledEditorOpen(true);
                      }}
                    />
                  ) : props.workbench ? (
                    <Workbench
                      workspaces={props.workspaces}
                      onOpen={props.onOpen ? open : undefined}
                    />
                  ) : (
                    (props.diagnosticView ?? (
                      <section
                        className="history-panel"
                        role={props.historyPanel ? 'tabpanel' : undefined}
                        id={props.historyPanel?.id}
                        aria-labelledby={props.historyPanel?.labelledBy}
                      >
                        {props.newConversation && props.composer && !messages.length ? (
                          <NewConversationWelcome
                            onSuggest={(value) => {
                              props.composer!.onChange(
                                props.composer!.draft
                                  ? `${props.composer!.draft}\n${value}`
                                  : value,
                              );
                              focusComposerAfterCommit();
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
                            messages={messages}
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
                            writeClipboardText={props.writeClipboardText}
                          />
                        )}
                      </section>
                    ))
                  )}
                  {!props.workbench && !props.scheduledTasks && (
                    <footer className="conversation-footer">
                      <div className="bottom-controls">
                        {props.interaction && (
                          <div className="interaction-area">{props.interaction}</div>
                        )}
                        {props.composer ? (
                          <Composer
                            {...props.composer}
                            promptHidden={!!props.interaction}
                            inputRef={composerInput}
                            context={
                              props.newConversation && (
                                <NewConversationContext {...props.newConversation} />
                              )
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
                  )}
                </div>
              </div>
            </main>
          </div>
        </ResizablePanel>
        {rightSidebarPanel && (
          <>
            <ResizableHandle id="details-resize" withHandle />
            <ResizablePanel id="details" defaultSize="380px" minSize="300px" maxSize="640px">
              {rightSidebarPanel}
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
      {narrow && (
        <Sheet
          open={sidebarOpen}
          onOpenChange={(open) => {
            setSidebarOpen(open);
            if (open) return;
            if (focusComposerOnClose.current) {
              focusComposerOnClose.current = false;
              focusComposerAfterCommit();
            } else toggle.current?.focus();
          }}
        >
          <SheetContent side="left" portalled={false} showCloseButton={false}>
            <SheetTitle className="sr-only">空间与会话</SheetTitle>
            <SheetDescription className="sr-only">选择空间或会话</SheetDescription>
            {sidebarPanel}
          </SheetContent>
        </Sheet>
      )}
      {props.overlays}
    </div>
  );
}
